"""Unified URL and media ingestion for Immersive Reading.

Imports always create a durable catalog row first, then move through processing
to ready/failed. API callers can therefore return immediately and poll REST;
the same service is also directly awaitable in tests and CLI integrations.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
import hashlib
import logging
import mimetypes
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Any
from urllib.parse import urlparse, urlunparse

import httpx

from eas.reading.catalog_models import (
    IngestionStatus,
    MaterialRecord,
    SourceKind,
)
from eas.reading.catalog_store import ReadingCatalogStore
from eas.reading.extract import split_markdown_by_headings
from eas.reading.models import OutlineEntry, ReadingError, UnitReference
from eas.reading.store import ReadingStore, content_hash
from eas.services.web_source.markdown import strip_leading_snapshot_provenance
from eas.services.web_source.snapshot_assets import (
    ImageFetcher,
    localize_snapshot_images,
)
from eas.services.workspace.activity import workspace_writer
from eas.tools.web_fetch import FetchOutcome, fetch_url_as_markdown

logger = logging.getLogger(__name__)

_AUDIO_SUFFIXES = {".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac", ".webm"}
# What the browser is told a stored media file is. ``mimetypes.guess_type``
# answers with registry names that no media element accepts — ``.m4a`` becomes
# ``audio/mp4a-latm`` (LATM-framed AAC, not what an .m4a holds) and ``.aac``
# becomes ``audio/x-aac`` — so a perfectly transcribed upload would not play.
_MEDIA_MIME = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
}
# Cut the audio into pieces a speech-to-text endpoint will accept. The pieces
# are a transport detail: cue timings come back from the provider and are
# rebased onto the clip, so this number no longer sets transcript granularity.
MEDIA_CHUNK_SECONDS = 600
MEDIA_PENDING_TEXT = "[Transcribing this media…]"
MEDIA_COVER_ASSET = "cover.jpg"
MAX_TRANSCRIPT_CUES = 20_000
MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024
MIN_SEGMENT_SECONDS = 20
MAX_SEGMENT_SECONDS = 90
TRANSCRIPT_UNAVAILABLE_TEXT = "[Transcript unavailable.]"


@dataclass(frozen=True, slots=True)
class TranscriptSegment:
    start_seconds: float
    end_seconds: float
    text: str


WebFetcher = Callable[..., Awaitable[FetchOutcome]]
MediaChunker = Callable[[Path], Awaitable[list[tuple[float, float, bytes]]]]
#: A transcriber answers with timed cues (``list[TranscriptCue]``) or, for a
#: provider that cannot report timings, one plain string. ``_rebase_cues``
#: normalises both, so the alias stays deliberately open at the return.
Transcriber = Callable[..., Awaitable[Any]]


def url_material_id(url: str) -> str:
    """The content id a URL import lands on.

    Duplicate detection has to answer "do I already have this link?" before the
    fetch, so the derivation lives here rather than inside the queueing path
    that used it.
    """
    return hashlib.sha256(normalize_url(url).encode("utf-8")).hexdigest()[:16]


class ReadingIngestionService:
    def __init__(
        self,
        reading_store: ReadingStore | None = None,
        catalog: ReadingCatalogStore | None = None,
        *,
        web_fetcher: WebFetcher = fetch_url_as_markdown,
        media_chunker: MediaChunker | None = None,
        transcriber: Transcriber | None = None,
        image_fetcher: ImageFetcher | None = None,
    ) -> None:
        self.catalog = catalog or ReadingCatalogStore()
        self.reading_store = reading_store or ReadingStore(self.catalog.root)
        self._web_fetcher = web_fetcher
        self._media_chunker = media_chunker or _chunk_media_audio
        self._image_fetcher = image_fetcher
        # Only the real provider is worth probing: an injected transcriber is a
        # test double or a caller's own pipeline, and has no catalog entry.
        self._probes_stt = transcriber is None
        if transcriber is None:
            from eas.services.voice import transcribe_audio_cues

            transcriber = transcribe_audio_cues
        self._transcriber = transcriber

    def queue_url(self, url: str, *, title: str = "") -> MaterialRecord:
        normalized = normalize_url(url)
        source_kind = SourceKind.WEB
        material_id = url_material_id(normalized)
        fallback_title = title.strip() or (urlparse(normalized).hostname or "Web source")
        return self.catalog.upsert_material(
            content_id=material_id,
            material_id=material_id,
            filename=f"{material_id}.url",
            title=fallback_title,
            source_kind=source_kind,
            source_url=normalized,
            mime="text/html",
            render_mode="text",
            status=IngestionStatus.QUEUED,
        )

    @workspace_writer
    async def process_url(
        self, material_id: str, *, preferred_languages: Sequence[str] = ("zh-CN", "zh", "en")
    ) -> MaterialRecord:
        record = self.catalog.get_material(material_id)
        if record is None or not record.source_url:
            raise ReadingError(f"queued URL material {material_id!r} not found")
        self.catalog.update_material_status(material_id, IngestionStatus.PROCESSING, progress=10)
        try:
            return await self._process_web(record)
        except Exception as exc:
            logger.exception(
                "Reading URL ingestion failed for material %s (%s)",
                material_id,
                record.source_kind.value,
            )
            code = "web_fetch_failed"
            return self.catalog.update_material_status(
                material_id,
                IngestionStatus.FAILED,
                error_code=code,
                error_detail=str(exc),
            )

    async def retry(self, material_id: str) -> MaterialRecord:
        record = self.catalog.get_material(material_id)
        if record is None:
            raise ReadingError(f"material {material_id!r} not found")
        if record.source_kind in {
            SourceKind.WEB,
        }:
            return await self.process_url(material_id)
        if record.source_kind in {SourceKind.VIDEO, SourceKind.AUDIO}:
            # The upload itself was stored before transcription was attempted,
            # so a retry re-runs speech-to-text instead of telling the user to
            # go and find the file again.
            return await self.process_media(material_id)
        raise ReadingError("this material cannot be re-imported; upload it again")

    async def _process_web(self, record: MaterialRecord) -> MaterialRecord:
        outcome = await self._web_fetcher(record.source_url, max_chars=500_000)
        if not outcome.ok:
            raise ReadingError(outcome.error or "web source could not be fetched")
        source_url = outcome.url or record.source_url
        markdown = strip_leading_snapshot_provenance(outcome.markdown)
        markdown, assets = await localize_snapshot_images(
            markdown,
            record.material_id,
            fetcher=self._image_fetcher,
        )
        units, outline = split_markdown_by_headings(markdown)
        if not units:
            raise ReadingError("web source contained no readable article text")
        self.reading_store.ingest_units(
            record.material_id,
            filename=f"{record.material_id}.md",
            units=units,
            unit="section",
            title=outcome.title or record.title,
            mime="text/markdown",
            extractor="safe-web-fetch",
            content_format="web_markdown",
            source_type="url_snapshot",
            source_url=source_url,
            assets=assets,
            # An empty outline means the page had only its synthetic title (or
            # no headings), so ReadingStore deliberately retains its existing
            # first-line fallback for unstructured web content.
            outline=outline or None,
        )
        return self.catalog.upsert_material(
            content_id=record.content_id,
            material_id=record.material_id,
            filename=f"{record.material_id}.md",
            title=outcome.title or record.title,
            source_kind=SourceKind.WEB,
            source_url=source_url,
            mime="text/markdown",
            render_mode="text",
            status=IngestionStatus.READY,
        )



    async def queue_media(
        self,
        source: Path | str,
        *,
        filename: str | None = None,
    ) -> MaterialRecord:
        """Store an upload and hand back a material that already plays.

        The bytes land before a single word is transcribed, and that ordering
        is the point: playback, the poster frame, and a retry that does not ask
        the user to find the file again all depend on the original being on
        disk. Transcription then runs in the background like every URL import,
        instead of holding an HTTP request open for the length of a lecture.
        """
        path = Path(source)
        try:
            raw = await asyncio.to_thread(path.read_bytes)
        except OSError as exc:
            raise ReadingError(f"{path.name}: could not be read ({exc})") from exc
        if not raw:
            raise ReadingError(f"{path.name} is empty")
        display_name = (filename or path.name).strip() or path.name
        material_id = content_hash(raw)
        kind, render_mode, mime = _media_identity(display_name)
        duration, cover = await _probe_media(path)

        await asyncio.to_thread(
            self.reading_store.ingest_units,
            material_id,
            filename=display_name,
            units=[MEDIA_PENDING_TEXT],
            unit="segment",
            title=Path(display_name).stem,
            mime=mime,
            extractor="media-pending",
            render_mode=render_mode,
            raw_data=raw,
            assets={MEDIA_COVER_ASSET: cover} if cover else None,
            outline=[OutlineEntry(locator=1, title=_clock(0))],
            unit_refs=[UnitReference(locator=1, source_href="#t=0", title=_clock(0))],
        )
        return self.catalog.upsert_material(
            content_id=material_id,
            material_id=material_id,
            filename=display_name,
            title=Path(display_name).stem,
            source_kind=kind,
            mime=mime,
            render_mode=render_mode,
            cover_url=media_cover_url(material_id) if cover else "",
            duration_seconds=duration,
            status=IngestionStatus.PROCESSING,
            progress=5,
        )

    @workspace_writer
    async def process_media(
        self,
        material_id: str,
        *,
        language: str | None = None,
    ) -> MaterialRecord:
        """Background entry point: transcribe, and record failure as state.

        Mirrors :meth:`process_url` — a background task that raises leaves a
        stack trace in the log and nothing the user can see, so the failure is
        written to the catalog and the material is returned either way.
        """
        try:
            return await self._transcribe_media(material_id, language=language)
        except Exception:
            record = self.catalog.get_material(material_id)
            if record is not None:
                return record
            raise

    async def _transcribe_media(
        self,
        material_id: str,
        *,
        language: str | None = None,
    ) -> MaterialRecord:
        """Transcribe a queued upload from the copy already on disk."""
        record = self.catalog.get_material(material_id)
        if record is None:
            raise ReadingError(f"queued media material {material_id!r} not found")
        try:
            manifest = self.reading_store.manifest(material_id)
            path = self.reading_store.raw_path(material_id)
        except ReadingError:
            path = None
            manifest = None
        if manifest is None or path is None or not path.is_file():
            return self.catalog.update_material_status(
                material_id,
                IngestionStatus.FAILED,
                error_code="media_source_missing",
                error_detail="the original media file is no longer stored; upload it again",
            )
        display_name = manifest.filename
        stem = Path(display_name).stem
        missing = _probe_stt_configuration() if self._probes_stt else ""
        if missing:
            # Check before spending ffmpeg on a file that cannot be transcribed,
            # and say which setting is missing rather than reporting a generic
            # transcription failure the user cannot act on.
            return self.catalog.update_material_status(
                material_id,
                IngestionStatus.FAILED,
                error_code="stt_not_configured",
                error_detail=missing,
            )
        self.catalog.update_material_status(material_id, IngestionStatus.PROCESSING, progress=15)
        try:
            chunks = await self._media_chunker(path)
            cues: list[TranscriptSegment] = []
            for index, (start, end, audio) in enumerate(chunks, start=1):
                spoken = await self._transcriber(
                    audio,
                    filename=f"{stem}-{index:04d}.mp3",
                    content_type="audio/mpeg",
                    language=language,
                )
                cues.extend(_rebase_cues(spoken, start, end))
                progress = 15 + round(index / max(1, len(chunks)) * 70)
                self.catalog.update_material_status(
                    material_id, IngestionStatus.PROCESSING, progress=progress
                )
            segments = build_transcript_segments(cues)
        except Exception as exc:
            logger.exception("Reading media ingestion failed for material %s", material_id)
            self.catalog.update_material_status(
                material_id,
                IngestionStatus.FAILED,
                error_code="media_transcription_failed",
                error_detail=str(exc),
            )
            raise

        # No speech is a property of the recording, not a failure of import:
        # a silent recording can still open and play.
        spoken = bool(segments)
        await asyncio.to_thread(
            self.reading_store.ingest_units,
            material_id,
            filename=display_name,
            units=[row.text for row in segments] if spoken else [TRANSCRIPT_UNAVAILABLE_TEXT],
            unit="segment",
            title=stem,
            mime=manifest.mime,
            extractor="configured-stt" if spoken else "media-no-speech",
            render_mode=manifest.render_mode,
            carry_source=True,
            outline=[
                OutlineEntry(locator=index, title=_clock(row.start_seconds))
                for index, row in enumerate(segments, start=1)
            ]
            if spoken
            else [OutlineEntry(locator=1, title=_clock(0))],
            unit_refs=[
                UnitReference(
                    locator=index,
                    source_href=f"#t={int(row.start_seconds)}",
                    title=_clock(row.start_seconds),
                )
                for index, row in enumerate(segments, start=1)
            ]
            if spoken
            else [UnitReference(locator=1, source_href="#t=0", title=_clock(0))],
        )
        return self.catalog.upsert_material(
            content_id=material_id,
            material_id=material_id,
            filename=display_name,
            title=stem,
            source_kind=record.source_kind,
            mime=manifest.mime,
            render_mode=manifest.render_mode,
            cover_url=record.cover_url,
            duration_seconds=record.duration_seconds,
            status=IngestionStatus.READY,
        )

    async def import_media(
        self,
        source: Path | str,
        *,
        filename: str | None = None,
        language: str | None = None,
    ) -> MaterialRecord:
        """Queue and transcribe in one await, for tests and direct callers."""
        record = await self.queue_media(source, filename=filename)
        return await self._transcribe_media(record.material_id, language=language)


def normalize_url(url: str) -> str:
    value = (url or "").strip().strip("`\"'")
    parsed = urlparse(value)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ReadingError("URL must use http:// or https:// and include a host")
    return urlunparse(
        (
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            parsed.path or "/",
            parsed.params,
            parsed.query,
            "",
        )
    )






def parse_timestamp(value: Any) -> int:
    raw = str(value or "").strip().lower()
    if raw.isdigit():
        return max(0, int(raw))
    match = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", raw)
    if not match or not any(match.groups()):
        return 0
    hours, minutes, seconds = (int(part or 0) for part in match.groups())
    return max(0, hours * 3600 + minutes * 60 + seconds)






def normalize_transcript_segments(rows: Sequence[Any]) -> list[TranscriptSegment]:
    """Normalize caption providers under a bounded storage budget."""

    result: list[TranscriptSegment] = []
    total_bytes = 0
    for row in list(rows)[:MAX_TRANSCRIPT_CUES]:
        if isinstance(row, dict):
            text = str(row.get("text") or row.get("content") or "").strip()
            start = row.get("start", row.get("from", 0))
            end = row.get("end", row.get("to", 0))
            duration = row.get("duration", 0)
        else:
            text = str(getattr(row, "text", "") or "").strip()
            start = getattr(row, "start", 0)
            end = getattr(row, "end", 0)
            duration = getattr(row, "duration", 0)
        if not text:
            continue
        encoded = text.encode("utf-8")
        if total_bytes + len(encoded) > MAX_TRANSCRIPT_BYTES:
            break
        try:
            start_value = max(0.0, float(start or 0))
            end_value = float(end or 0)
            if end_value <= start_value:
                end_value = start_value + max(0.0, float(duration or 0))
        except (TypeError, ValueError):
            continue
        result.append(TranscriptSegment(start_value, max(start_value, end_value), text))
        total_bytes += len(encoded)
    return result


def build_transcript_segments(cues: Sequence[TranscriptSegment]) -> list[TranscriptSegment]:
    """Merge subtitle flashes into stable 20–90 second learning units."""

    merged: list[TranscriptSegment] = []
    current: TranscriptSegment | None = None
    for cue in cues:
        if current is None:
            current = cue
            continue
        gap = max(0.0, cue.start_seconds - current.end_seconds)
        length = cue.end_seconds - current.start_seconds
        sentence_end = current.text.rstrip().endswith((".", "!", "?"))
        if (
            length < MAX_SEGMENT_SECONDS
            and gap <= 4
            and not (length >= MIN_SEGMENT_SECONDS and sentence_end)
        ):
            current = TranscriptSegment(
                current.start_seconds,
                cue.end_seconds,
                f"{current.text} {cue.text}".strip(),
            )
        else:
            merged.append(current)
            current = cue
    if current is not None:
        merged.append(current)
    return merged










def _probe_stt_configuration() -> str:
    """Why speech-to-text cannot run, or "" when it can.

    Asked before ffmpeg touches the file: without a provider the work is
    guaranteed to be wasted, and "no speech-to-text model is configured" is
    something the user can act on, unlike a generic transcription failure.
    """
    try:
        from eas.services.config.provider_runtime import resolve_stt_runtime_config

        resolve_stt_runtime_config()
    except Exception as exc:
        return str(exc) or "No speech-to-text model is configured."
    return ""


async def _chunk_media_audio(path: Path) -> list[tuple[float, float, bytes]]:
    if shutil.which("ffmpeg") is None:
        raise ReadingError("Video transcription requires ffmpeg on the server")

    def run() -> list[tuple[float, float, bytes]]:
        tmp_dir = Path(tempfile.mkdtemp(prefix="dt-reading-audio-"))
        try:
            pattern = tmp_dir / "chunk-%04d.mp3"
            listing = tmp_dir / "segments.csv"
            command = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(path),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "segment",
                "-segment_time",
                str(MEDIA_CHUNK_SECONDS),
                # The muxer knows where it actually cut; asking it beats
                # assuming every piece is exactly ``segment_time`` long, which
                # made the final piece claim time the media does not have.
                "-segment_list",
                str(listing),
                "-segment_list_type",
                "csv",
                "-c:a",
                "libmp3lame",
                str(pattern),
            ]
            completed = subprocess.run(
                command, capture_output=True, text=True, timeout=3600, check=False
            )
            if completed.returncode != 0:
                raise ReadingError(completed.stderr.strip() or "ffmpeg could not read this media")
            spans = _segment_list_spans(listing)
            chunks: list[tuple[float, float, bytes]] = []
            for index, chunk in enumerate(sorted(tmp_dir.glob("chunk-*.mp3"))):
                if not chunk.stat().st_size:
                    continue
                start, end = spans.get(
                    chunk.name,
                    (
                        float(index * MEDIA_CHUNK_SECONDS),
                        float((index + 1) * MEDIA_CHUNK_SECONDS),
                    ),
                )
                chunks.append((start, end, chunk.read_bytes()))
            return chunks
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    return await asyncio.to_thread(run)


def _segment_list_spans(listing: Path) -> dict[str, tuple[float, float]]:
    """Parse ffmpeg's ``filename,start,end`` segment list, tolerating absence."""
    try:
        rows = listing.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    spans: dict[str, tuple[float, float]] = {}
    for row in rows:
        parts = row.strip().split(",")
        if len(parts) < 3:
            continue
        try:
            start, end = float(parts[-2]), float(parts[-1])
        except ValueError:
            continue
        if start < 0 or end < start:
            continue
        spans[Path(parts[0]).name] = (start, end)
    return spans


async def _probe_media(path: Path) -> tuple[float, bytes]:
    """Best-effort duration and poster frame. Never fatal: media still plays."""

    def run() -> tuple[float, bytes]:
        duration = 0.0
        if shutil.which("ffprobe"):
            probe = subprocess.run(  # nosec B607 - fixed argv, no shell; which() guarded, PATH lookup deliberate
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(path),
                ],
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            try:
                duration = max(0.0, float((probe.stdout or "").strip()))
            except ValueError:
                duration = 0.0
        cover = b""
        if shutil.which("ffmpeg"):
            offset = min(3.0, duration / 2) if duration else 0.0
            frame = subprocess.run(  # nosec B607 - same fixed argv + which() guard as the ffprobe call
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    f"{offset:.3f}",
                    "-i",
                    str(path),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=640:-2",
                    "-f",
                    "mjpeg",
                    "-",
                ],
                capture_output=True,
                timeout=120,
                check=False,
            )
            # Audio-only files have no video stream; an empty cover is normal.
            if frame.returncode == 0 and frame.stdout[:2] == b"\xff\xd8":
                cover = frame.stdout
        return duration, cover

    try:
        return await asyncio.to_thread(run)
    except Exception:  # pragma: no cover - probing must never break ingestion
        logger.warning("media probe failed for %s", path.name, exc_info=True)
        return 0.0, b""


def _media_identity(display_name: str) -> tuple[SourceKind, str, str]:
    """Kind, renderer and *browser-playable* MIME for an uploaded media file."""
    suffix = Path(display_name).suffix.lower()
    is_audio = suffix in _AUDIO_SUFFIXES and suffix != ".webm"
    kind = SourceKind.AUDIO if is_audio else SourceKind.VIDEO
    render_mode = "audio" if is_audio else "video"
    mime = _MEDIA_MIME.get(suffix) or mimetypes.guess_type(display_name)[0]
    return kind, render_mode, mime or "application/octet-stream"


def media_cover_url(material_id: str) -> str:
    """Where the poster frame captured at import time is served from."""
    from eas.services.workspace.context import workspace_url

    return workspace_url(f"/api/reading/materials/{material_id}/assets/{MEDIA_COVER_ASSET}")


def _rebase_cues(spoken: Any, start: float, end: float) -> list[TranscriptSegment]:
    """Move one chunk's transcript onto the clip's own timeline.

    Providers that return timed cues give real per-utterance timestamps, which
    is what makes a citation land on the sentence rather than on the ten-minute
    block it happened to fall in. A provider (or a caller) that answers with
    plain text still works — that transcript simply covers the whole chunk.
    """
    if isinstance(spoken, str):
        text = spoken.strip()
        return [TranscriptSegment(start, end, text)] if text else []
    rows: list[TranscriptSegment] = []
    for cue in spoken or []:
        text = str(getattr(cue, "text", "") or "").strip()
        if not text:
            continue
        if not getattr(cue, "timed", False):
            rows.append(TranscriptSegment(start, end, text))
            continue
        cue_start = start + max(0.0, float(getattr(cue, "start_seconds", 0.0)))
        cue_end = start + max(0.0, float(getattr(cue, "end_seconds", 0.0)))
        rows.append(TranscriptSegment(cue_start, max(cue_start, cue_end), text))
    return rows


def _clock(seconds: float) -> str:
    value = max(0, int(seconds))
    hours, remainder = divmod(value, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}" if hours else f"{minutes:02d}:{secs:02d}"


__all__ = [
    "ReadingIngestionService",
    "TranscriptSegment",
    "TRANSCRIPT_UNAVAILABLE_TEXT",
    "build_transcript_segments",
    "media_cover_url",
    "normalize_url",
    "normalize_transcript_segments",
    "parse_timestamp",
]

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from eas.reading import ingestion as ingestion_module
from eas.reading.catalog_models import IngestionStatus, SourceKind
from eas.reading.catalog_store import ReadingCatalogStore
from eas.reading.extract import (
    SECTION_HARD_CHARS,
    split_into_sections,
    split_markdown_by_headings,
)
from eas.reading.ingestion import (
    MAX_TRANSCRIPT_BYTES,
    ReadingIngestionService,
    build_transcript_segments,
    normalize_transcript_segments,
)
from eas.reading.models import (
    Annotation,
    ReadingError,
    TextPositionSelector,
    TextQuoteSelector,
)
from eas.reading.store import ReadingStore
from eas.services.web_source.snapshot_assets import SnapshotAsset
from eas.tools.web_fetch import FetchOutcome, _extract_readable

_ARTICLE_FIXTURE = Path(__file__).parents[1] / "fixtures" / "web" / "vector_article.html"


@pytest.fixture
def stores(tmp_path: Path):
    root = tmp_path / "reading"
    return ReadingStore(root), ReadingCatalogStore(root)


@pytest.mark.asyncio
async def test_web_import_uses_safe_fetch_result_and_builds_sections(stores) -> None:
    reading, catalog = stores

    async def fetcher(url: str, **_kwargs):
        return FetchOutcome(
            ok=True,
            url=url,
            title="A careful article",
            markdown="# A careful article\n\nFirst claim.\n\nSecond claim.",
        )

    service = ReadingIngestionService(reading, catalog, web_fetcher=fetcher)
    queued = service.queue_url("https://example.com/article")
    ready = await service.process_url(queued.material_id)

    assert queued.status is IngestionStatus.QUEUED
    assert ready.status is IngestionStatus.READY
    assert ready.source_kind is SourceKind.WEB
    manifest = reading.manifest(ready.material_id)
    assert manifest.title == "A careful article"
    assert "First claim" in reading.unit_text(ready.material_id, 1)
    assert reading.outline(ready.material_id)[0].synthesised is True


@pytest.mark.asyncio
async def test_web_import_is_rich_localizes_images_and_preserves_old_revision(stores) -> None:
    reading, catalog = stores
    url = "https://example.com/article"

    async def fetcher(_url: str, **_kwargs):
        return FetchOutcome(
            ok=True,
            url="https://example.com/final/article",
            title="Snapshot",
            markdown=(
                "<!-- source: https://example.com/legacy -->\n"
                "# Snapshot\n\n![Diagram](https://cdn.example.com/diagram.png)"
            ),
        )

    async def image_fetcher(_url: str):
        return SnapshotAsset(b"\x89PNG\r\n\x1a\nimage", "image/png", "png")

    service = ReadingIngestionService(
        reading,
        catalog,
        web_fetcher=fetcher,
        image_fetcher=image_fetcher,
    )
    queued = service.queue_url(url)
    reading.ingest_units(
        queued.material_id,
        filename=f"{queued.material_id}.md",
        units=["<!-- source: https://example.com/old -->\n# Old snapshot"],
        source_type="url_snapshot",
        source_url=url,
    )

    ready = await service.process_url(queued.material_id)
    manifest = reading.manifest(ready.material_id)
    current = reading.unit_text(ready.material_id, 1)

    assert manifest.content_format == "web_markdown"
    assert manifest.source_url == "https://example.com/final/article"
    assert manifest.revision == 2
    assert "<!-- source:" not in current
    assert "/api/reading/materials/" in current
    assert (
        reading.asset_path(
            ready.material_id,
            next((reading._dir(ready.material_id) / "assets").iterdir()).name,
        )
        is not None
    )
    revisions = reading.revisions(ready.material_id)
    assert [row.revision for row in revisions] == [1]
    assert "# Old snapshot" in reading.revision_unit_text(ready.material_id, 1, 1)


def test_revision_migration_reanchors_reliable_quote(stores) -> None:
    reading, _catalog = stores
    material_id = "abcdef0123456789"

    reading.ingest_units(
        material_id,
        filename="article.md",
        units=["# First section\n\nThe quick brown fox jumps over the lazy dog."],
        source_type="url_snapshot",
    )
    annotation = reading.save_annotation(
        material_id,
        Annotation(
            annotation_id="test001",
            locator=1,
            quote="quick brown fox",
            selectors=(
                TextQuoteSelector(
                    exact="quick brown fox",
                    prefix="The ",
                    suffix=" jumps",
                ),
                TextPositionSelector(start=21, end=36),
            ),
        ),
    )
    assert annotation.material_revision == 1

    reading.ingest_units(
        material_id,
        filename="article-v2.md",
        units=["# Revised\n\nIntro. The quick brown fox jumps over the lazy dog. End."],
        source_type="url_snapshot",
    )
    stored = reading.annotations(material_id)
    assert len(stored) == 1
    migrated = stored[0]
    assert migrated.resolution == "resolved"
    assert migrated.material_revision == 2
    assert "quick brown fox" in migrated.quote
    quote_selector = next(s for s in migrated.selectors if isinstance(s, TextQuoteSelector))
    position_selector = next(s for s in migrated.selectors if isinstance(s, TextPositionSelector))
    unit_text = reading.unit_text(material_id, migrated.locator)
    assert unit_text[position_selector.start : position_selector.end] == quote_selector.exact


def test_revision_migration_checks_each_material_annotation_file(stores) -> None:
    reading, _catalog = stores
    material_id = "abcdef0123456789"
    reading.ingest_units(
        material_id,
        filename="article.md",
        units=["The quick brown fox jumps. A second claim stays here."],
        source_type="url_snapshot",
    )
    reading.save_annotation(
        material_id,
        Annotation(
            annotation_id="first",
            locator=1,
            quote="quick brown fox",
            selectors=(TextQuoteSelector(exact="quick brown fox"),),
        ),
    )
    second_path = reading._dir(material_id) / "annotations" / "another-material.json"
    second_path.write_text(
        json.dumps(
            [
                Annotation(
                    annotation_id="second",
                    locator=1,
                    quote="second claim",
                    selectors=(TextQuoteSelector(exact="second claim"),),
                ).to_dict(),
                Annotation(
                    annotation_id="position-only",
                    locator=1,
                    selectors=(TextPositionSelector(start=5, end=10),),
                ).to_dict(),
            ]
        ),
        encoding="utf-8",
    )

    reading.ingest_units(
        material_id,
        filename="article-v2.md",
        units=["An introduction. The quick brown fox jumps. A second claim stays here."],
        source_type="url_snapshot",
    )

    assert reading.annotations(material_id)[0].material_revision == 2
    second_rows = [Annotation.from_dict(row) for row in json.loads(second_path.read_text())]
    assert second_rows[0].material_revision == 2
    assert second_rows[0].resolution == "resolved"
    assert second_rows[1].material_revision == 1
    assert second_rows[1].resolution == "unresolved"


def test_revision_migration_marks_gone_quote_unresolved(stores) -> None:
    reading, _catalog = stores
    material_id = "abcdef0123456789"

    reading.ingest_units(
        material_id,
        filename="article.md",
        units=["# Section\n\nThe unique phrase is here."],
        source_type="url_snapshot",
    )
    reading.save_annotation(
        material_id,
        Annotation(
            annotation_id="test002",
            locator=1,
            quote="unique phrase",
            selectors=(TextQuoteSelector(exact="unique phrase", prefix="The ", suffix=" is"),),
        ),
    )

    reading.ingest_units(
        material_id,
        filename="article-v2.md",
        units=["# Rewritten\n\nEntirely different content."],
        source_type="url_snapshot",
    )
    stored = reading.annotations(material_id)
    assert len(stored) == 1
    assert stored[0].resolution == "unresolved"
    assert stored[0].material_revision == 1  # kept pinned to old revision
    assert stored[0].quote == "unique phrase"


def test_revision_migration_marks_repeated_quote_ambiguous(stores) -> None:
    reading, _catalog = stores
    material_id = "abcdef0123456789"

    reading.ingest_units(
        material_id,
        filename="article.md",
        units=["# Section\n\nA key claim with unique context."],
        source_type="url_snapshot",
    )
    reading.save_annotation(
        material_id,
        Annotation(
            annotation_id="test003",
            locator=1,
            quote="key claim",
            selectors=(TextQuoteSelector(exact="key claim", prefix="A ", suffix=" with"),),
        ),
    )

    reading.ingest_units(
        material_id,
        filename="article-v2.md",
        units=["# Duplicated\n\nA key claim here.\n\nAnother key claim there."],
        source_type="url_snapshot",
    )
    stored = reading.annotations(material_id)
    assert len(stored) == 1
    assert stored[0].resolution == "ambiguous"
    assert stored[0].material_revision == 1


def test_revision_migration_preserves_old_annotations_for_audit(stores) -> None:
    reading, _catalog = stores
    material_id = "abcdef0123456789"

    reading.ingest_units(
        material_id,
        filename="article.md",
        units=["# Section\n\nThe original phrase."],
        source_type="url_snapshot",
    )
    reading.save_annotation(
        material_id,
        Annotation(
            annotation_id="test004",
            locator=1,
            quote="original phrase",
            selectors=(TextQuoteSelector(exact="original phrase"),),
        ),
    )

    reading.ingest_units(
        material_id,
        filename="article-v2.md",
        units=["# Changed\n\nA new phrase entirely."],
        source_type="url_snapshot",
    )

    revision_dir = reading._dir(material_id) / "revisions" / "000001"
    assert revision_dir.is_dir()
    saved_annotations = revision_dir / "annotations" / f"{material_id}.json"
    assert saved_annotations.is_file()
    import json

    saved_rows = json.loads(saved_annotations.read_text(encoding="utf-8"))
    assert len(saved_rows) == 1
    assert saved_rows[0]["quote"] == "original phrase"
    assert saved_rows[0]["resolution"] == "resolved"


@pytest.mark.asyncio
async def test_web_article_fixture_builds_heading_derived_outline(stores) -> None:
    reading, catalog = stores
    title, markdown = _extract_readable(_ARTICLE_FIXTURE.read_text(encoding="utf-8"))

    async def fetcher(url: str, **_kwargs):
        return FetchOutcome(ok=True, url=url, title=title, markdown=markdown)

    service = ReadingIngestionService(reading, catalog, web_fetcher=fetcher)
    queued = service.queue_url("https://example.com/structured-article")
    ready = await service.process_url(queued.material_id)

    assert ready.status is IngestionStatus.READY
    assert reading.manifest(ready.material_id).unit_count == 4
    outline = reading.outline(ready.material_id)
    assert [(row.locator, row.title, row.level) for row in outline] == [
        (1, "Transformer (deep learning)", 1),
        (2, "History", 2),
        (3, "Predecessors", 3),
        (4, "Applications", 2),
    ]
    assert all(row.synthesised is False for row in outline)
    stored_text = "\n".join(
        reading.unit_text(ready.material_id, locator) for locator in range(1, 5)
    )
    assert "Jump to content" not in stored_text
    assert "navigation footer" not in stored_text


def test_heading_sections_keep_long_continuations_under_the_same_title() -> None:
    markdown = (
        "# Article\n\nLead.\n\n## Long section\n\n"
        + ("history detail " * (SECTION_HARD_CHARS // 8))
        + "\n\n## Finish\n\nDone."
    )

    units, outline = split_markdown_by_headings(markdown)

    long_rows = [row for row in outline if row.title == "Long section"]
    assert len(long_rows) > 1
    assert [row.locator for row in long_rows] == list(
        range(long_rows[0].locator, long_rows[-1].locator + 1)
    )
    # The first piece also carries the heading line; the paragraph payload
    # itself still obeys the existing hard-split limit.
    assert all(
        len(units[row.locator - 1]) <= SECTION_HARD_CHARS + len("## Long section\n\n")
        for row in long_rows
    )


@pytest.mark.parametrize(
    "block",
    [
        pytest.param("````md\n```py\n# Not a heading\n```\n````", id="longer-fence-around-example"),
        pytest.param("```bash\n```py\n# Not a heading\n```", id="fence-with-info-does-not-close"),
        pytest.param("~~~\n# Not a heading\n~~~", id="tilde-fence"),
    ],
)
def test_heading_splitter_ignores_headings_inside_fenced_code(block: str) -> None:
    markdown = f"# Guide\n\nIntro.\n\n{block}\n\n## Next\n\nDone."

    units, outline = split_markdown_by_headings(markdown)

    assert [row.title for row in outline] == ["Guide", "Next"]
    assert "# Not a heading" in units[0]


def test_heading_splitter_does_not_open_a_fence_on_inline_backticks() -> None:
    markdown = "# Guide\n\n```inline``` code.\n\n## Next\n\nDone."

    _units, outline = split_markdown_by_headings(markdown)

    assert [row.title for row in outline] == ["Guide", "Next"]


def test_heading_splitter_falls_back_when_only_the_page_title_exists() -> None:
    markdown = "# Article title\n\nA flat article paragraph.\n\nAnother paragraph."

    units, outline = split_markdown_by_headings(markdown)

    assert units == split_into_sections(markdown)
    assert outline == ()


@pytest.mark.asyncio
async def test_failed_url_import_is_retryable(stores, caplog: pytest.LogCaptureFixture) -> None:
    _reading, catalog = stores

    async def fetcher(_url: str, **_kwargs):
        return FetchOutcome(ok=False, error="blocked by host policy")

    service = ReadingIngestionService(stores[0], catalog, web_fetcher=fetcher)
    queued = service.queue_url("https://example.com/private")
    with caplog.at_level(logging.ERROR, logger="eas.reading.ingestion"):
        failed = await service.process_url(queued.material_id)

    assert failed.status is IngestionStatus.FAILED
    assert failed.error_code == "web_fetch_failed"
    assert "blocked" in failed.error_detail
    assert "Reading URL ingestion failed" in caplog.text




def test_caption_flashes_become_stable_learning_segments() -> None:
    cues = [
        TranscriptSegment(0.0, 10.0, "One"),
        TranscriptSegment(10.0, 22.0, "sentence."),
        TranscriptSegment(22.0, 45.0, "Next concept."),
    ]
    segments = build_transcript_segments(cues)
    assert segments[0] == TranscriptSegment(0.0, 22.0, "One sentence.")
    assert segments[1].start_seconds == 22.0


def test_transcript_normalization_has_a_storage_budget(monkeypatch) -> None:
    monkeypatch.setattr("eas.reading.ingestion.MAX_TRANSCRIPT_BYTES", 8)
    cues = normalize_transcript_segments(
        [
            {"start": 0, "duration": 1, "text": "1234"},
            {"start": 1, "duration": 1, "text": "5678"},
            {"start": 2, "duration": 1, "text": "overflow"},
        ]
    )
    assert MAX_TRANSCRIPT_BYTES > 8
    assert [cue.text for cue in cues] == ["1234", "5678"]


@pytest.mark.asyncio
async def test_local_video_keeps_playable_raw_and_transcribes_chunks(
    stores, tmp_path: Path
) -> None:
    reading, catalog = stores
    source = tmp_path / "lecture.mp4"
    source.write_bytes(b"fake but stable video bytes")

    async def chunker(_path: Path):
        return [(0.0, 600.0, b"audio-one"), (600.0, 720.0, b"audio-two")]

    async def transcriber(audio: bytes, **_kwargs):
        return "first section" if audio == b"audio-one" else "second section"

    service = ReadingIngestionService(
        reading,
        catalog,
        media_chunker=chunker,
        transcriber=transcriber,
    )
    ready = await service.import_media(source, filename="lecture.mp4")

    assert ready.status is IngestionStatus.READY
    assert ready.source_kind is SourceKind.VIDEO
    assert reading.manifest(ready.material_id).render_mode == "video"
    assert reading.raw_path(ready.material_id).read_bytes() == source.read_bytes()
    assert reading.unit_text(ready.material_id, 2) == "second section"


@pytest.mark.asyncio
async def test_media_without_a_configured_provider_fails_before_running_ffmpeg(
    stores, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Name the missing setting, and do not spend ffmpeg proving it is missing."""
    reading, catalog = stores
    source = tmp_path / "lecture.mp4"
    source.write_bytes(b"video bytes")
    ran = {"chunker": False}

    async def chunker(_path: Path):
        ran["chunker"] = True
        return []

    monkeypatch.setattr(
        ingestion_module,
        "_probe_stt_configuration",
        lambda: "No active STT model is configured. Set it in Settings > Voice.",
    )
    service = ReadingIngestionService(reading, catalog, media_chunker=chunker)
    service._probes_stt = True

    queued = await service.queue_media(source, filename="lecture.mp4")
    failed = await service.process_media(queued.material_id)

    assert failed.status is IngestionStatus.FAILED
    assert failed.error_code == "stt_not_configured"
    assert "Settings > Voice" in failed.error_detail
    assert ran["chunker"] is False
    # The upload survives the failure, so configuring a provider and retrying
    # is all the user has to do.
    assert reading.raw_path(queued.material_id).read_bytes() == b"video bytes"


@pytest.mark.asyncio
async def test_media_retry_reruns_transcription_from_the_stored_original(
    stores, tmp_path: Path
) -> None:
    """A failed transcription must not cost the user the upload.

    The original is stored before speech-to-text is attempted, so retrying is
    a server-side re-run — not "please find that two-gigabyte lecture again".
    """
    reading, catalog = stores
    source = tmp_path / "lecture.mp4"
    source.write_bytes(b"stable video bytes")
    attempts = {"n": 0}

    async def chunker(_path: Path):
        return [(0.0, 600.0, b"audio-one")]

    async def transcriber(_audio: bytes, **_kwargs):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise RuntimeError("No endpoint URL configured for STT.")
        return "the transcript, second time around"

    service = ReadingIngestionService(
        reading, catalog, media_chunker=chunker, transcriber=transcriber
    )
    queued = await service.queue_media(source, filename="lecture.mp4")
    failed = await service.process_media(queued.material_id)

    assert failed.status is IngestionStatus.FAILED
    # Still playable while it is broken: the bytes never depended on the text.
    assert reading.raw_path(queued.material_id).read_bytes() == b"stable video bytes"

    recovered = await service.retry(queued.material_id)

    assert recovered.status is IngestionStatus.READY
    assert reading.unit_text(queued.material_id, 1) == "the transcript, second time around"
    assert reading.raw_path(queued.material_id).read_bytes() == b"stable video bytes"


@pytest.mark.asyncio
async def test_media_ingestion_failure_is_logged_and_persisted(
    stores,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reading, catalog = stores
    source = tmp_path / "broken.mp4"
    source.write_bytes(b"broken video")

    async def failing_chunker(_path: Path):
        raise RuntimeError("decoder crashed")

    monkeypatch.setattr(ingestion_module, "_probe_stt_configuration", lambda: "")
    service = ReadingIngestionService(*stores, media_chunker=failing_chunker)
    with caplog.at_level(logging.ERROR, logger="eas.reading.ingestion"):
        with pytest.raises(RuntimeError, match="decoder crashed"):
            await service.import_media(source)

    material_id = next(row.material_id for row in catalog.list_materials())
    failed = catalog.get_material(material_id)
    assert failed is not None
    assert failed.status is IngestionStatus.FAILED
    assert "Reading media ingestion failed" in caplog.text

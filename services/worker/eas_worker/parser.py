from __future__ import annotations

import hashlib
import re
import statistics
from dataclasses import dataclass, replace
from pathlib import Path

import pymupdf

from packages.shared.providers import ParserProvider

MIN_MEANINGFUL_CHARS = 40
MAX_IMAGES_PER_PAGE = 20
MAX_IMAGE_BYTES = 8 * 1024 * 1024
FORMULA_HINT = re.compile(r"(?:=|≤|≥|∑|∫|√|\^|_[a-zA-Z0-9])")
BOLD_FONT_FLAG = 16


def _text_blocks(page) -> list[ParsedBlock]:
    """Extract text blocks and retain conservative font-based heading hints."""
    raw = page.get_text("dict", sort=True).get("blocks", [])
    text_rows: list[tuple[str, list[float], list[float], bool]] = []
    page_width = float(page.rect.width)
    for item in raw:
        if item.get("type") != 0:
            continue
        lines = item.get("lines", [])
        spans = [
            (line_index, span)
            for line_index, line in enumerate(lines)
            for span in line.get("spans", [])
            if span.get("text", "").strip()
        ]
        if not spans:
            continue

        # PyMuPDF can combine two columns on one baseline into a single text block.
        # Split span groups only when their horizontal separation resembles a gutter.
        ordered_spans = sorted(spans, key=lambda pair: float(pair[1]["bbox"][0]))
        split_at = max(
            range(1, len(ordered_spans)),
            key=lambda index: (
                float(ordered_spans[index][1]["bbox"][0])
                - float(ordered_spans[index - 1][1]["bbox"][2])
            ),
            default=0,
        )
        span_gap = (
            float(ordered_spans[split_at][1]["bbox"][0])
            - float(ordered_spans[split_at - 1][1]["bbox"][2])
            if split_at
            else 0.0
        )
        span_groups = (
            [ordered_spans[:split_at], ordered_spans[split_at:]]
            if split_at and span_gap >= max(30.0, page_width * 0.06)
            else [spans]
        )
        for group in span_groups:
            group.sort(key=lambda pair: (pair[0], float(pair[1]["bbox"][0])))
            text = " ".join(str(span.get("text", "")).strip() for _, span in group).strip()
            if not text:
                continue
            sizes = [float(span.get("size", 0)) for _, span in group]
            is_bold = any(int(span.get("flags", 0)) & BOLD_FONT_FLAG for _, span in group)
            bbox = [
                min(float(span["bbox"][0]) for _, span in group),
                min(float(span["bbox"][1]) for _, span in group),
                max(float(span["bbox"][2]) for _, span in group),
                max(float(span["bbox"][3]) for _, span in group),
            ]
            text_rows.append((text, bbox, sizes, is_bold))

    # Switch to column-major order only when a clear gutter separates two groups
    # containing repeated, narrow blocks.
    ordered_starts = sorted((row[1][0], index) for index, row in enumerate(text_rows))
    split_at = max(
        range(1, len(ordered_starts)),
        key=lambda index: ordered_starts[index][0] - ordered_starts[index - 1][0],
        default=0,
    )
    gutter = ordered_starts[split_at][0] - ordered_starts[split_at - 1][0] if split_at else 0.0
    if (
        split_at
        and gutter >= max(36.0, page_width * 0.18)
        and split_at >= 2
        and len(ordered_starts) - split_at >= 2
        and all(row[1][2] - row[1][0] < page_width * 0.75 for row in text_rows)
    ):
        left_ids = {item[1] for item in ordered_starts[:split_at]}
        right_ids = {item[1] for item in ordered_starts[split_at:]}
        left = sorted(
            (row for index, row in enumerate(text_rows) if index in left_ids),
            key=lambda row: row[1][1],
        )
        right = sorted(
            (row for index, row in enumerate(text_rows) if index in right_ids),
            key=lambda row: row[1][1],
        )
        text_rows = left + right

    typical_size = (
        statistics.median(size for _, _, sizes, _ in text_rows for size in sizes)
        if text_rows
        else 0
    )
    blocks = []
    for text, bbox, sizes, is_bold in text_rows:
        mean_size = statistics.mean(sizes)
        short_heading = len(text) <= 180 and "\n" not in text
        source_type = (
            "heading"
            if short_heading and typical_size > 0 and mean_size >= max(13.0, typical_size * 1.25)
            else "paragraph"
        )
        if (
            source_type == "paragraph"
            and short_heading
            and is_bold
            and mean_size >= max(12.0, typical_size * 1.12)
        ):
            source_type = "heading"
        blocks.append(ParsedBlock(text=text, source_type=source_type, bbox=bbox))
    return blocks


@dataclass(frozen=True)
class ParsedBlock:
    text: str
    source_type: str
    bbox: list[float] | None


@dataclass(frozen=True)
class ParsedAsset:
    data: bytes
    media_type: str
    extension: str


@dataclass(frozen=True)
class ParsedPage:
    page_number: int
    text: str
    text_hash: str
    blocks: list[ParsedBlock]
    assets: list[ParsedAsset]
    quality_score: float
    status: str
    fallback_required: bool
    fallback_used: bool
    is_ocr: bool
    tables_detected: int
    formulas_detected: int
    warnings: list[str]
    parser_name: str = "pymupdf"


class PageParser(ParserProvider):
    """Low-level page parser. Holds one open document; call methods serially in one thread."""

    def __init__(self, path: Path, media_type: str, ocr_language: str, min_chars: int):
        self.document = pymupdf.open(path)
        if self.document.needs_pass:
            self.document.close()
            raise ValueError("Encrypted documents are not supported")
        self.media_type = media_type
        self.ocr_language = ocr_language
        self.min_chars = min_chars
        self.parser_name = "pymupdf"
        self.parser_warnings: list[str] = []

    @property
    def page_count(self) -> int:
        return self.document.page_count

    def parse_page(self, page_number: int) -> ParsedPage:
        page = self.document.load_page(page_number - 1)
        warnings: list[str] = []
        assets: list[ParsedAsset] = []
        blocks: list[ParsedBlock] = []
        is_ocr = False

        text_parts: list[str] = []
        blocks = _text_blocks(page)
        for block in blocks:
            text_parts.append(block.text)
        text = "\n\n".join(text_parts).strip()
        has_visual_content = bool(blocks or page.get_images(full=True) or page.get_drawings())
        fallback_required = len(text) < self.min_chars and has_visual_content

        # Only invoke the slow OCR path when preflight quality signals indicate it may help.
        if fallback_required:
            try:
                text_page = page.get_textpage_ocr(
                    language=self.ocr_language,
                    dpi=200,
                    full=True,
                )
                ocr_text = page.get_text("text", textpage=text_page).strip()
                if len(ocr_text) > len(text):
                    text = ocr_text
                    is_ocr = True
                    blocks = [ParsedBlock(text=ocr_text, source_type="ocr", bbox=None)]
            except Exception as exc:
                warnings.append(f"OCR_UNAVAILABLE_{type(exc).__name__}")

        if self.media_type == "application/pdf":
            for image_index, image_info in enumerate(
                page.get_images(full=True)[:MAX_IMAGES_PER_PAGE], start=1
            ):
                try:
                    extracted = self.document.extract_image(image_info[0])
                    image_data = extracted["image"]
                    if len(image_data) > MAX_IMAGE_BYTES:
                        warnings.append("IMAGE_ASSET_EXCEEDS_LIMIT")
                        continue
                    ext = extracted.get("ext", "bin").lower()
                    media_type = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
                    assets.append(ParsedAsset(image_data, media_type, ext))
                except Exception as exc:
                    warnings.append(f"IMAGE_EXTRACTION_FAILED_{image_index}_{type(exc).__name__}")

        tables_detected = 0
        table_finder = getattr(page, "find_tables", None)
        if table_finder is not None:
            try:
                found_tables = table_finder().tables
                tables_detected = len(found_tables)
                for table in found_tables:
                    rows = table.extract()
                    table_text = "\n".join("\t".join(cell or "" for cell in row) for row in rows)
                    if table_text.strip():
                        blocks.append(
                            ParsedBlock(
                                text=table_text,
                                source_type="table",
                                bbox=[float(value) for value in table.bbox],
                            )
                        )
            except Exception as exc:
                warnings.append(f"TABLE_EXTRACTION_FAILED_{type(exc).__name__}")

        formulas = sum(1 for part in text_parts if FORMULA_HINT.search(part))
        meaningful_chars = len(text.replace("\n", "").strip())
        if meaningful_chars == 0 and not assets:
            # Preserve blank pages without treating them as extraction failures.
            status = "READY"
            quality = 1.0
            warnings.append("BLANK_PAGE")
        elif meaningful_chars >= self.min_chars:
            status = "READY"
            quality = min(1.0, 0.8 + meaningful_chars / 2000)
        else:
            status = "DEGRADED"
            quality = min(0.79, meaningful_chars / max(self.min_chars, 1))
            if fallback_required and not is_ocr:
                warnings.append("LOW_TEXT_QUALITY")

        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        return ParsedPage(
            page_number=page_number,
            text=text,
            text_hash=digest,
            blocks=blocks,
            assets=assets,
            quality_score=quality,
            status=status,
            fallback_required=fallback_required,
            fallback_used=is_ocr,
            is_ocr=is_ocr,
            tables_detected=tables_detected,
            formulas_detected=formulas,
            warnings=self.parser_warnings + warnings,
            parser_name=self.parser_name,
        )

    def close(self) -> None:
        self.document.close()


class DoclingPageParser(ParserProvider):
    """Structured layout adapter with PyMuPDF retained for page quality and assets."""

    def __init__(
        self,
        path: Path,
        media_type: str,
        ocr_language: str,
        min_chars: int,
        max_pages: int,
    ):
        if media_type != "application/pdf":
            raise ValueError("The Docling parser backend currently supports PDF documents only")
        try:
            from docling.document_converter import DocumentConverter
        except ImportError as exc:
            raise RuntimeError(
                "Docling parser selected but unavailable; install eas-backend[parser-docling]"
            ) from exc
        self.fallback = PageParser(path, media_type, ocr_language, min_chars)
        self.path = path
        self.max_pages = max_pages
        self.converter = DocumentConverter()

    @property
    def page_count(self) -> int:
        return self.fallback.page_count

    @staticmethod
    def _collect_structured_items(structured_document, page_number: int) -> list[ParsedBlock]:
        blocks = []
        for item, _level in structured_document.iterate_items():
            provenance = getattr(item, "prov", None) or []
            if not provenance:
                continue
            location = provenance[0]
            if int(location.page_no) != page_number:
                continue
            label = getattr(getattr(item, "label", None), "value", "")
            source_type = {
                "section_header": "heading",
                "title": "title",
                "table": "table",
                "formula": "formula",
            }.get(str(label).lower(), "paragraph")
            text = getattr(item, "text", None)
            if source_type == "table":
                export = getattr(item, "export_to_markdown", None)
                if callable(export):
                    try:
                        text = export(doc=structured_document)
                    except Exception:
                        pass
            text = str(text or "").strip()
            if not text:
                continue
            bbox = location.bbox
            pages = getattr(structured_document, "pages", {})
            page_info = pages.get(page_number)
            if page_info is None:
                page_info = pages.get(str(page_number))
            page_size = getattr(page_info, "size", None)
            height = getattr(page_size, "height", None)
            to_top_left = getattr(bbox, "to_top_left_origin", None)
            if callable(to_top_left) and height is not None:
                try:
                    bbox = to_top_left(page_height=float(height))
                except Exception:
                    pass
            coordinates = [float(getattr(bbox, key)) for key in ("l", "t", "r", "b")]
            blocks.append(ParsedBlock(text=text, source_type=source_type, bbox=coordinates))
        return blocks

    def _needs_structured_parse(self, page: ParsedPage) -> bool:
        if (
            page.fallback_required
            or page.status == "DEGRADED"
            or page.tables_detected
            or page.formulas_detected
        ):
            return True
        page_width = float(self.fallback.document[page.page_number - 1].rect.width)
        starts = sorted(
            block.bbox[0]
            for block in page.blocks
            if block.bbox and block.bbox[2] - block.bbox[0] < page_width * 0.75
        )
        if len(starts) < 4:
            return False
        gaps = [right - left for left, right in zip(starts, starts[1:], strict=False)]
        largest_gap = max(gaps, default=0)
        split = gaps.index(largest_gap) + 1 if gaps else 0
        return largest_gap >= page_width * 0.18 and split >= 2 and len(starts) - split >= 2

    def parse_page(self, page_number: int) -> ParsedPage:
        fallback = self.fallback.parse_page(page_number)
        if not self._needs_structured_parse(fallback):
            return fallback
        try:
            converted = self.converter.convert(
                self.path,
                raises_on_error=True,
                max_num_pages=self.max_pages,
                page_range=(page_number, page_number),
            )
            blocks = self._collect_structured_items(converted.document, page_number)
        except Exception as exc:
            return replace(
                fallback,
                warnings=fallback.warnings + [f"DOCLING_PAGE_FAILED_{type(exc).__name__}"],
                parser_name="pymupdf_fallback",
            )
        text = "\n\n".join(block.text for block in blocks)
        if not blocks or not text:
            return replace(
                fallback,
                warnings=fallback.warnings + ["DOCLING_PAGE_EMPTY_PYMUPDF_FALLBACK"],
                parser_name="pymupdf_fallback",
            )
        meaningful_chars = len(text.replace("\n", "").strip())
        status = "READY" if meaningful_chars >= self.fallback.min_chars else fallback.status
        quality = (
            min(1.0, 0.8 + meaningful_chars / 2000) if status == "READY" else fallback.quality_score
        )
        return replace(
            fallback,
            text=text,
            text_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            blocks=blocks,
            status=status,
            quality_score=quality,
            tables_detected=sum(block.source_type == "table" for block in blocks),
            formulas_detected=sum(block.source_type == "formula" for block in blocks),
            warnings=fallback.warnings,
            parser_name="docling",
        )

    def close(self) -> None:
        self.fallback.close()


class MinerUPageParser(ParserProvider):
    """Optional MinerU structured-content adapter with PyMuPDF quality fallback."""

    def __init__(
        self,
        path: Path,
        media_type: str,
        ocr_language: str,
        min_chars: int,
        max_pages: int,
    ):
        if media_type != "application/pdf":
            raise ValueError("The MinerU parser backend currently supports PDF documents only")
        try:
            from mineru.parser import parse
        except ImportError as exc:
            raise RuntimeError(
                "MinerU parser selected but unavailable; install eas-backend[parser-mineru]"
            ) from exc
        self.fallback = PageParser(path, media_type, ocr_language, min_chars)
        self.path = path
        self.parse = parse
        self.max_pages = max_pages
        if self.fallback.page_count > max_pages:
            raise ValueError("PDF exceeds the configured page limit")

    def _needs_mineru_parse(self, page: ParsedPage) -> bool:
        if (
            page.fallback_required
            or page.status == "DEGRADED"
            or page.tables_detected
            or page.formulas_detected
        ):
            return True
        page_width = float(self.fallback.document[page.page_number - 1].rect.width)
        starts = sorted(
            block.bbox[0]
            for block in page.blocks
            if block.bbox and block.bbox[2] - block.bbox[0] < page_width * 0.75
        )
        gaps = [right - left for left, right in zip(starts, starts[1:], strict=False)]
        largest_gap = max(gaps, default=0)
        return len(starts) >= 4 and largest_gap >= page_width * 0.18

    @staticmethod
    def _structured_blocks(structured: dict[str, object], page_number: int) -> list[ParsedBlock]:
        pages = structured.get("pages", [])
        if not isinstance(pages, list):
            return []
        page = next(
            (
                item
                for item in pages
                if isinstance(item, dict) and int(item.get("page_idx", -1)) + 1 == page_number
            ),
            None,
        )
        if page is None and len(pages) == 1 and isinstance(pages[0], dict):
            page = pages[0]
        if page is None or not isinstance(page.get("blocks"), list):
            return []
        blocks = []
        for item in page["blocks"]:
            if not isinstance(item, dict):
                continue
            kind = str(item.get("type", "text")).casefold()
            source_type = (
                "table" if "table" in kind else
                "formula" if "equation" in kind or "formula" in kind else
                "heading" if kind in {"title", "heading"} else "paragraph"
            )
            content = item.get("content", "")
            if isinstance(content, list):
                content = " ".join(
                    str(part.get("content", "")) if isinstance(part, dict) else str(part)
                    for part in content
                )
            text = str(content).strip()
            if not text:
                continue
            box = item.get("bbox")
            if isinstance(box, dict):
                bbox = [box.get(key) for key in ("l", "t", "r", "b")]
            elif isinstance(box, (list, tuple)) and len(box) == 4:
                bbox = list(box)
            else:
                bbox = None
            try:
                parsed_bbox = [float(value) for value in bbox] if bbox is not None else None
            except (TypeError, ValueError):
                parsed_bbox = None
            blocks.append(ParsedBlock(text=text, source_type=source_type, bbox=parsed_bbox))
        return blocks

    @property
    def page_count(self) -> int:
        return self.fallback.page_count

    def parse_page(self, page_number: int) -> ParsedPage:
        fallback = self.fallback.parse_page(page_number)
        if not self._needs_mineru_parse(fallback):
            return fallback
        try:
            result = self.parse(
                str(self.path), tier="standard", page_range=f"{page_number}-{page_number}"
            )
            blocks = self._structured_blocks(result.structured_content(), page_number)
        except Exception as exc:
            return replace(
                fallback,
                warnings=fallback.warnings + [f"MINERU_PAGE_FAILED_{type(exc).__name__}"],
                parser_name="pymupdf_fallback",
            )
        text = "\n\n".join(block.text for block in blocks)
        if not text.strip():
            return replace(
                fallback,
                warnings=fallback.warnings + ["MINERU_PAGE_EMPTY_PYMUPDF_FALLBACK"],
                parser_name="pymupdf_fallback",
            )
        meaningful_chars = len(text.replace("\n", "").strip())
        return replace(
            fallback,
            text=text,
            text_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            blocks=blocks,
            status="READY" if meaningful_chars >= self.fallback.min_chars else fallback.status,
            quality_score=min(1.0, 0.8 + meaningful_chars / 2000),
            tables_detected=sum(block.source_type == "table" for block in blocks),
            formulas_detected=sum(block.source_type == "formula" for block in blocks),
            warnings=fallback.warnings,
            parser_name="mineru",
        )

    def close(self) -> None:
        self.fallback.close()


def create_parser(
    path: Path,
    media_type: str,
    ocr_language: str,
    min_chars: int,
    backend: str = "pymupdf",
    max_pages: int = 500,
) -> ParserProvider:
    if backend == "pymupdf":
        return PageParser(path, media_type, ocr_language, min_chars)
    if backend == "docling":
        try:
            return DoclingPageParser(path, media_type, ocr_language, min_chars, max_pages)
        except Exception as exc:
            fallback = PageParser(path, media_type, ocr_language, min_chars)
            fallback.parser_name = "pymupdf_fallback"
            fallback.parser_warnings.append(f"DOCLING_INIT_FAILED_{type(exc).__name__}")
            return fallback
    if backend == "mineru":
        try:
            return MinerUPageParser(path, media_type, ocr_language, min_chars, max_pages)
        except Exception as exc:
            fallback = PageParser(path, media_type, ocr_language, min_chars)
            fallback.parser_name = "pymupdf_fallback"
            fallback.parser_warnings.append(f"MINERU_INIT_FAILED_{type(exc).__name__}")
            return fallback
    raise ValueError(f"Unsupported parser backend: {backend}")

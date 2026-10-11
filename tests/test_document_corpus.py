"""Generated document fixtures for parser quality and page-coverage evaluation."""

import importlib.util
from pathlib import Path

import pymupdf
import pytest

from services.worker.eas_worker.parser import create_parser


def _save_text_pdf(path: Path, pages: list[str]) -> None:
    document = pymupdf.open()
    for text in pages:
        page = document.new_page()
        if text:
            page.insert_text((72, 72), text, fontsize=11)
    document.save(path)
    document.close()


def _build_corpus(directory: Path) -> dict[str, Path]:
    corpus: dict[str, Path] = {}
    text_path = directory / "text.pdf"
    _save_text_pdf(
        text_path,
        [
            f"Page {number} has enough ordinary text for reliable extraction and evaluation."
            for number in range(1, 4)
        ],
    )
    corpus["text"] = text_path

    columns_path = directory / "two-column.pdf"
    document = pymupdf.open()
    page = document.new_page()
    for y, left, right in [
        (
            72,
            "Left column first paragraph contains explanatory text.",
            "Right column first paragraph adds context.",
        ),
        (
            112,
            "Left column second paragraph continues the topic.",
            "Right column second paragraph concludes the topic.",
        ),
    ]:
        page.insert_text((72, y), left, fontsize=11)
        page.insert_text((330, y), right, fontsize=11)
    document.save(columns_path)
    document.close()
    corpus["two_column"] = columns_path

    source_path = directory / "scan-source.pdf"
    _save_text_pdf(source_path, ["Scanned page text remains visible inside a raster image."])
    source_doc = pymupdf.open(source_path)
    raster = source_doc[0].get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5)).tobytes("png")
    source_doc.close()
    scanned_path = directory / "scanned.pdf"
    scanned = pymupdf.open()
    scanned_page = scanned.new_page()
    scanned_page.insert_image(scanned_page.rect, stream=raster)
    scanned.save(scanned_path)
    scanned.close()
    corpus["scanned"] = scanned_path

    equation_path = directory / "equations.pdf"
    _save_text_pdf(
        equation_path,
        ["Newton's second law: F = m a. Energy: E = m c^2. Summation: ∑ x_i."],
    )
    corpus["equations"] = equation_path

    table_path = directory / "table.pdf"
    table_doc = pymupdf.open()
    table_page = table_doc.new_page()
    left, top, cell_width, cell_height = 72, 72, 110, 32
    rows = [["Mass", "Force"], ["2 kg", "19.6 N"], ["4 kg", "39.2 N"]]
    for row_index, row in enumerate(rows):
        for column_index, value in enumerate(row):
            x0 = left + column_index * cell_width
            y0 = top + row_index * cell_height
            table_page.draw_rect(pymupdf.Rect(x0, y0, x0 + cell_width, y0 + cell_height))
            table_page.insert_text((x0 + 8, y0 + 21), value, fontsize=11)
    table_doc.save(table_path)
    table_doc.close()
    corpus["table"] = table_path

    image_path = directory / "image-heavy.pdf"
    image_source = pymupdf.open()
    image_source.new_page().insert_text((72, 72), "Figure sample", fontsize=16)
    pixmap = image_source[0].get_pixmap(matrix=pymupdf.Matrix(1.2, 1.2))
    image_bytes = pixmap.tobytes("png")
    image_source.close()
    image_doc = pymupdf.open()
    image_page = image_doc.new_page()
    for position in range(4):
        x = 35 + (position % 2) * 270
        y = 45 + (position // 2) * 350
        image_page.insert_image(pymupdf.Rect(x, y, x + 220, y + 280), stream=image_bytes)
    image_doc.save(image_path)
    image_doc.close()
    corpus["image_heavy"] = image_path

    large_path = directory / "large-205-pages.pdf"
    _save_text_pdf(
        large_path,
        [
            f"Page {number}: a large document page with a complete sentence for extraction."
            for number in range(1, 206)
        ],
    )
    corpus["large"] = large_path
    return corpus


@pytest.mark.parametrize("backend", ["pymupdf", "docling"])
def test_parser_corpus_accounts_for_pages_and_expected_structure(tmp_path, backend):
    if backend == "docling" and importlib.util.find_spec("docling") is None:
        pytest.skip("Install eas-backend[parser-docling] to evaluate the Docling backend")

    corpus = _build_corpus(tmp_path)
    for name, path in corpus.items():
        parser = create_parser(path, "application/pdf", "eng", 40, backend, 500)
        try:
            expected_pages = 205 if name == "large" else 3 if name == "text" else 1
            assert parser.page_count == expected_pages, name
            parsed = [
                parser.parse_page(page_number) for page_number in range(1, expected_pages + 1)
            ]
        finally:
            parser.close()

        assert [page.page_number for page in parsed] == list(range(1, expected_pages + 1)), name
        assert all(page.status in {"READY", "DEGRADED", "FAILED"} for page in parsed), name
        assert all(page.text_hash for page in parsed), name
        if name == "two_column":
            assert parsed[0].blocks[0].text.startswith("Left column")
        elif name == "equations":
            assert parsed[0].formulas_detected >= 1
        elif name == "table":
            assert any(block.source_type == "table" for block in parsed[0].blocks)
        elif name == "image_heavy":
            assert parsed[0].assets
        elif name == "scanned":
            assert parsed[0].fallback_required

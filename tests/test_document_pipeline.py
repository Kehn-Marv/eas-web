import hashlib
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pymupdf
import pytest
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from packages.shared import models as _models  # noqa: F401
from packages.shared.db import Base
from packages.shared.models import (
    Document,
    DocumentBlock,
    DocumentPage,
    DocumentSection,
    DocumentStatus,
    LearningSession,
    PageStatus,
)
from packages.shared.storage import FilesystemStorage
from services.api.eas_api.config import Settings
from services.worker.eas_worker.documents import process_document_job
from services.worker.eas_worker.indexing import index_document
from services.worker.eas_worker.parser import create_parser


def make_pdf(path: Path, texts: list[str]) -> None:
    document = pymupdf.open()
    for text in texts:
        page = document.new_page()
        if text:
            page.insert_text((72, 72), text, fontsize=12)
    document.save(path)
    document.close()


@pytest.mark.asyncio
async def test_index_assigns_existing_blocks_only_after_all_sections_exist():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    @event.listens_for(engine.sync_engine, "connect")
    def enable_foreign_keys(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        learner = LearningSession()
        db.add(learner)
        await db.flush()
        document = Document(
            session_id=learner.id,
            filename="multiple-sections.pdf",
            media_type="application/pdf",
            content_hash="a" * 64,
            object_key="documents/multiple-sections/original.pdf",
            byte_size=128,
            status=DocumentStatus.BUILDING_INDEX,
            completeness_status="complete",
        )
        db.add(document)
        await db.flush()
        document_id = document.id
        db.add_all(
            [
                DocumentBlock(
                    document_id=document_id,
                    page_number=1,
                    block_index=0,
                    source_type="heading",
                    text="1. First section",
                    content_hash="b" * 64,
                ),
                DocumentBlock(
                    document_id=document_id,
                    page_number=1,
                    block_index=1,
                    source_type="paragraph",
                    text="The first section contains useful study material.",
                    content_hash="c" * 64,
                ),
                DocumentBlock(
                    document_id=document_id,
                    page_number=1,
                    block_index=2,
                    source_type="heading",
                    text="2. Second section",
                    content_hash="d" * 64,
                ),
                DocumentBlock(
                    document_id=document_id,
                    page_number=1,
                    block_index=3,
                    source_type="paragraph",
                    text="The second section contains more useful study material.",
                    content_hash="e" * 64,
                ),
            ]
        )
        await db.commit()

    await index_document({"document_id": str(document_id)}, engine, Settings())

    async with sessions() as db:
        document = await db.get(Document, document_id)
        sections = list(
            (
                await db.scalars(
                    select(DocumentSection)
                    .where(DocumentSection.document_id == document_id)
                    .order_by(DocumentSection.ordinal)
                )
            ).all()
        )
        blocks = list(
            (
                await db.scalars(
                    select(DocumentBlock)
                    .where(DocumentBlock.document_id == document_id)
                    .order_by(DocumentBlock.block_index)
                )
            ).all()
        )
        assert document.status == DocumentStatus.READY
        assert document.index_status == "ready"
        assert len(sections) == 2
        assert [block.section_id for block in blocks] == [
            sections[0].id,
            sections[0].id,
            sections[1].id,
            sections[1].id,
        ]
    await engine.dispose()


def test_parser_preserves_typographic_heading_signals(tmp_path):
    source = tmp_path / "heading.pdf"
    pdf = pymupdf.open()
    page = pdf.new_page()
    page.insert_text((72, 72), "1 Forces", fontsize=20, fontname="hebo")
    page.insert_text((72, 112), "Force is a push or pull on an object.", fontsize=11)
    pdf.save(source)
    pdf.close()

    parser = create_parser(source, "application/pdf", "eng", 40)
    try:
        result = parser.parse_page(1)
    finally:
        parser.close()
    assert [(block.text, block.source_type) for block in result.blocks] == [
        ("1 Forces", "heading"),
        ("Force is a push or pull on an object.", "paragraph"),
    ]


def test_parser_reads_two_columns_top_to_bottom_by_column(tmp_path):
    source = tmp_path / "columns.pdf"
    pdf = pymupdf.open()
    page = pdf.new_page()
    page.insert_text((72, 72), "Left column begins with the first explanation.", fontsize=11)
    page.insert_text((330, 72), "Right column begins with another explanation.", fontsize=11)
    page.insert_text((72, 112), "Left column continues with additional details.", fontsize=11)
    page.insert_text((330, 112), "Right column continues with additional details.", fontsize=11)
    pdf.save(source)
    pdf.close()

    parser = create_parser(source, "application/pdf", "eng", 40)
    try:
        result = parser.parse_page(1)
    finally:
        parser.close()
    assert [block.text for block in result.blocks] == [
        "Left column begins with the first explanation.",
        "Left column continues with additional details.",
        "Right column begins with another explanation.",
        "Right column continues with additional details.",
    ]


def test_docling_backend_maps_structured_blocks_and_table_export(tmp_path, monkeypatch):
    source = tmp_path / "structured.pdf"
    make_pdf(source, ["PyMuPDF fallback text is available on this page."])

    class Box:
        def __init__(self):
            self.l, self.t, self.r, self.b = 72.0, 50.0, 300.0, 80.0

        @staticmethod
        def to_top_left_origin(page_height):
            assert page_height == 792
            return Box()

    provenance = [SimpleNamespace(page_no=1, bbox=Box())]
    items = [
        SimpleNamespace(
            label=SimpleNamespace(value="section_header"),
            text="1 Motion",
            prov=provenance,
        ),
        SimpleNamespace(
            label=SimpleNamespace(value="paragraph"),
            text="Motion describes how position changes over time.",
            prov=provenance,
        ),
        SimpleNamespace(
            label=SimpleNamespace(value="table"),
            text="",
            prov=provenance,
            export_to_markdown=lambda doc: "| Speed | Unit |\n| --- | --- |\n| 2 | m/s |",
        ),
    ]

    class FakeDocument:
        pages = {1: SimpleNamespace(size=SimpleNamespace(height=792))}

        @staticmethod
        def iterate_items():
            return ((item, 0) for item in items)

    class FakeConverter:
        @staticmethod
        def convert(path, **kwargs):
            assert path == source
            assert kwargs["max_num_pages"] == 10
            assert kwargs["page_range"] == (1, 1)
            return SimpleNamespace(document=FakeDocument())

    docling_module = ModuleType("docling")
    docling_module.__path__ = []
    converter_module = ModuleType("docling.document_converter")
    converter_module.DocumentConverter = FakeConverter
    monkeypatch.setitem(sys.modules, "docling", docling_module)
    monkeypatch.setitem(sys.modules, "docling.document_converter", converter_module)

    parser = create_parser(source, "application/pdf", "eng", 1000, "docling", 10)
    try:
        result = parser.parse_page(1)
    finally:
        parser.close()
    assert result.parser_name == "docling"
    assert [block.source_type for block in result.blocks] == ["heading", "paragraph", "table"]
    assert "| Speed | Unit |" in result.text


def test_docling_startup_failure_falls_back_to_pymupdf(tmp_path, monkeypatch):
    source = tmp_path / "fallback.pdf"
    make_pdf(source, ["A sufficiently long page remains readable with PyMuPDF fallback."])

    class BrokenConverter:
        def convert(self, path, **kwargs):
            raise RuntimeError("private conversion details")

    docling_module = ModuleType("docling")
    docling_module.__path__ = []
    converter_module = ModuleType("docling.document_converter")
    converter_module.DocumentConverter = BrokenConverter
    monkeypatch.setitem(sys.modules, "docling", docling_module)
    monkeypatch.setitem(sys.modules, "docling.document_converter", converter_module)

    parser = create_parser(source, "application/pdf", "eng", 1000, "docling", 10)
    try:
        result = parser.parse_page(1)
    finally:
        parser.close()
    assert result.parser_name == "pymupdf_fallback"
    assert "DOCLING_PAGE_FAILED_RuntimeError" in result.warnings
    assert "private conversion details" not in " ".join(result.warnings)


def test_mineru_adapter_maps_page_structured_content_and_falls_back(tmp_path, monkeypatch):
    source = tmp_path / "mineru.pdf"
    make_pdf(source, ["PyMuPDF page fallback contains enough meaningful words here."])

    class FakeResult:
        @staticmethod
        def structured_content():
            return {
                "pages": [
                    {
                        "page_idx": 0,
                        "blocks": [
                            {"type": "title", "content": "1 Motion", "bbox": [10, 20, 300, 40]},
                            {"type": "table", "content": "Speed | Unit", "bbox": [10, 50, 300, 90]},
                            {"type": "equation", "content": "v = d / t"},
                        ],
                    }
                ]
            }

    mineru_package = ModuleType("mineru")
    mineru_package.__path__ = []
    parser_module = ModuleType("mineru.parser")
    parser_module.parse = lambda path, **kwargs: FakeResult()
    monkeypatch.setitem(sys.modules, "mineru", mineru_package)
    monkeypatch.setitem(sys.modules, "mineru.parser", parser_module)

    parser = create_parser(source, "application/pdf", "eng", 1000, "mineru", 10)
    try:
        result = parser.parse_page(1)
    finally:
        parser.close()
    assert result.parser_name == "mineru"
    assert [block.source_type for block in result.blocks] == ["heading", "table", "formula"]
    assert result.blocks[0].bbox == [10.0, 20.0, 300.0, 40.0]


@pytest.mark.asyncio
async def test_all_expected_pages_are_extracted_and_retry_is_idempotent(tmp_path):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    storage = FilesystemStorage(tmp_path / "objects")
    source = tmp_path / "two-pages.pdf"
    make_pdf(
        source,
        [
            "This first page contains a sufficiently long text passage for extraction.",
            "The second page also contains enough useful words for a stable quality result.",
        ],
    )
    document_id = None
    object_key = None
    async with sessions() as db:
        learner = LearningSession()
        db.add(learner)
        await db.flush()
        content = source.read_bytes()
        document = Document(
            session_id=learner.id,
            filename="two-pages.pdf",
            media_type="application/pdf",
            content_hash=hashlib.sha256(content).hexdigest(),
            object_key="documents/test/original.pdf",
            byte_size=len(content),
            status=DocumentStatus.VALIDATING,
        )
        db.add(document)
        await db.commit()
        document_id = document.id
        object_key = document.object_key
    await storage.put_file(object_key, source, "application/pdf")
    settings = Settings(max_pdf_pages=50)

    payload = {"document_id": str(document_id)}
    await process_document_job(payload, engine, storage, settings)
    await process_document_job(payload, engine, storage, settings)
    await index_document(payload, engine)

    async with sessions() as db:
        document = await db.get(Document, document_id)
        pages = list(
            (
                await db.scalars(
                    select(DocumentPage).where(DocumentPage.document_id == document_id)
                )
            ).all()
        )
        assert document.status == DocumentStatus.READY
        assert document.completeness_status == "complete"
        assert document.expected_page_count == 2
        assert document.processed_page_count == 2
        assert document.failed_page_count == 0
        assert document.text_char_count > 80
        assert len(pages) == 2
        assert all(page.status == PageStatus.READY for page in pages)
    await engine.dispose()


@pytest.mark.asyncio
async def test_blank_page_is_accounted_without_claiming_missing_text(tmp_path):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    storage = FilesystemStorage(tmp_path / "objects")
    source = tmp_path / "blank.pdf"
    make_pdf(source, [""])
    async with sessions() as db:
        learner = LearningSession()
        db.add(learner)
        await db.flush()
        document = Document(
            session_id=learner.id,
            filename="blank.pdf",
            media_type="application/pdf",
            content_hash=hashlib.sha256(source.read_bytes()).hexdigest(),
            object_key="documents/blank/original.pdf",
            byte_size=source.stat().st_size,
            status=DocumentStatus.VALIDATING,
        )
        db.add(document)
        await db.commit()
        document_id = document.id
    await storage.put_file("documents/blank/original.pdf", source, "application/pdf")

    await process_document_job({"document_id": str(document_id)}, engine, storage, Settings())
    await index_document({"document_id": str(document_id)}, engine)
    async with sessions() as db:
        document = await db.get(Document, document_id)
        page = await db.scalar(select(DocumentPage).where(DocumentPage.document_id == document_id))
        assert document.expected_page_count == document.processed_page_count == 1
        assert document.status == DocumentStatus.READY
        assert page.status == PageStatus.READY
        assert "BLANK_PAGE" in page.warning
    await engine.dispose()


@pytest.mark.asyncio
async def test_image_only_page_is_routed_to_ocr_fallback(tmp_path):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    storage = FilesystemStorage(tmp_path / "objects")
    source_text = tmp_path / "source-text.pdf"
    make_pdf(
        source_text, ["A sufficiently long sentence that becomes a scanned image for OCR routing."]
    )
    source_doc = pymupdf.open(source_text)
    image_path = tmp_path / "page-image.png"
    source_doc[0].get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5)).save(image_path)
    source_doc.close()
    scanned_pdf = pymupdf.open()
    scanned_page = scanned_pdf.new_page()
    scanned_page.insert_image(scanned_page.rect, filename=str(image_path))
    scanned_bytes = scanned_pdf.tobytes()
    scanned_pdf.close()
    scanned_path = tmp_path / "scanned.pdf"
    scanned_path.write_bytes(scanned_bytes)
    async with sessions() as db:
        learner = LearningSession()
        db.add(learner)
        await db.flush()
        document = Document(
            session_id=learner.id,
            filename="scanned.pdf",
            media_type="application/pdf",
            content_hash=hashlib.sha256(scanned_bytes).hexdigest(),
            object_key="documents/scanned/original.pdf",
            byte_size=len(scanned_bytes),
            status=DocumentStatus.VALIDATING,
        )
        db.add(document)
        await db.commit()
        document_id = document.id
    await storage.put_file("documents/scanned/original.pdf", scanned_path, "application/pdf")

    await process_document_job({"document_id": str(document_id)}, engine, storage, Settings())
    async with sessions() as db:
        document = await db.get(Document, document_id)
        page = await db.scalar(select(DocumentPage).where(DocumentPage.document_id == document_id))
        assert document.expected_page_count == document.processed_page_count == 1
        assert document.pages_needing_fallback == 1
        assert page.fallback_required is True
        assert page.status in (PageStatus.READY, PageStatus.DEGRADED)
        if not page.fallback_used:
            assert any(warning.startswith("OCR_UNAVAILABLE") for warning in page.warning)
    await engine.dispose()

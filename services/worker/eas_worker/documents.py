import asyncio
import hashlib
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid5

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncEngine

from packages.shared.db import make_session_factory
from packages.shared.models import (
    Document,
    DocumentAsset,
    DocumentBlock,
    DocumentPage,
    DocumentStatus,
    Job,
    JobStatus,
    PageStatus,
)
from packages.shared.storage import StorageProvider
from services.api.eas_api.config import Settings
from services.worker.eas_worker.parser import (
    DoclingPageParser,
    PageParser,
    ParsedPage,
    create_parser,
)


def _asset_key(document_id: UUID, page_number: int, asset_index: int, extension: str) -> str:
    return f"documents/{document_id}/figures/page-{page_number:05d}-{asset_index:03d}.{extension}"


async def _finish_document(
    factory, document_id: UUID, expected_count: int, aggregate_error: str | None = None
):
    async with factory() as db:
        document = await db.get(Document, document_id)
        pages = list(
            (
                await db.scalars(
                    select(DocumentPage).where(DocumentPage.document_id == document_id)
                )
            ).all()
        )
        processed = sum(
            page.status in (PageStatus.READY, PageStatus.DEGRADED, PageStatus.FAILED)
            for page in pages
        )
        failed = sum(page.status == PageStatus.FAILED for page in pages)
        degraded = sum(page.status == PageStatus.DEGRADED for page in pages)
        accounted = len(pages) == expected_count and processed == expected_count
        document.expected_page_count = expected_count
        document.processed_page_count = processed
        document.failed_page_count = failed
        document.pages_needing_fallback = sum(page.fallback_required for page in pages)
        document.text_char_count = sum(page.char_count for page in pages)
        document.tables_detected = sum(page.tables_detected for page in pages)
        document.formulas_detected = sum(page.formulas_detected for page in pages)
        document.ocr_page_count = sum(page.is_ocr for page in pages)
        document.figures_detected = (
            await db.scalar(
                select(func.count(DocumentAsset.id)).where(DocumentAsset.document_id == document_id)
            )
            or 0
        )
        warnings = [
            f"PAGE_{page.page_number}:{warning}" for page in pages for warning in page.warning
        ]
        if aggregate_error:
            warnings.append(aggregate_error)
        document.warnings = list(dict.fromkeys(warnings))
        if not accounted:
            document.status = DocumentStatus.FAILED
            document.completeness_status = "failed"
            document.warnings.append("PAGE_COVERAGE_MISMATCH")
        elif failed == expected_count and expected_count:
            document.status = DocumentStatus.FAILED
            document.completeness_status = "failed"
        else:
            document.completeness_status = (
                "partial"
                if failed
                or degraded
                or any(not warning.endswith(":BLANK_PAGE") for warning in warnings)
                else "complete"
            )
            document.status = DocumentStatus.BUILDING_INDEX
            document.index_status = "pending"
            source_revision = hashlib.sha256(
                "|".join(sorted(page.text_hash or "" for page in pages)).encode("utf-8")
            ).hexdigest()[:24]
            key = f"document-index:{document_id}:{source_revision}"
            existing = await db.scalar(select(Job).where(Job.idempotency_key == key))
            if existing is None:
                db.add(
                    Job(
                        job_type="document.index",
                        payload={"document_id": str(document_id)},
                        idempotency_key=key,
                        status=JobStatus.QUEUED,
                    )
                )
            elif existing.status == JobStatus.COMPLETED:
                document.index_status = "ready"
                document.status = (
                    DocumentStatus.READY
                    if document.completeness_status == "complete"
                    else DocumentStatus.DEGRADED
                )
        await db.commit()


async def _persist_page(factory, storage: StorageProvider, document_id: UUID, result: ParsedPage):
    stored_assets: list[tuple[str, str, str, int]] = []
    asset_warnings: list[str] = []
    for index, asset in enumerate(result.assets, start=1):
        key = _asset_key(document_id, result.page_number, index, asset.extension)
        digest = hashlib.sha256(asset.data).hexdigest()
        with tempfile.NamedTemporaryFile(
            prefix="eas-asset-", suffix=f".{asset.extension}", delete=False
        ) as temp:
            temp.write(asset.data)
            asset_path = Path(temp.name)
        try:
            await storage.put_file(key, asset_path, asset.media_type)
            stored_assets.append((key, asset.media_type, digest, len(asset.data)))
        except Exception as exc:
            asset_warnings.append(f"ASSET_STORAGE_FAILED_{type(exc).__name__}")
        finally:
            asset_path.unlink(missing_ok=True)

    async with factory() as db:
        page = await db.scalar(
            select(DocumentPage).where(
                DocumentPage.document_id == document_id,
                DocumentPage.page_number == result.page_number,
            )
        )
        if page is None:
            raise RuntimeError("Page inventory row is missing")

        await db.execute(
            delete(DocumentBlock).where(
                DocumentBlock.document_id == document_id,
                DocumentBlock.page_number == result.page_number,
            )
        )
        old_assets = list(
            (
                await db.scalars(
                    select(DocumentAsset).where(
                        DocumentAsset.document_id == document_id,
                        DocumentAsset.page_number == result.page_number,
                    )
                )
            ).all()
        )
        await db.execute(
            delete(DocumentAsset).where(
                DocumentAsset.document_id == document_id,
                DocumentAsset.page_number == result.page_number,
            )
        )
        for old_asset in old_assets:
            if old_asset.object_key not in {item[0] for item in stored_assets}:
                await storage.delete(old_asset.object_key)

        for block_index, block in enumerate(result.blocks):
            db.add(
                DocumentBlock(
                    id=uuid5(document_id, f"page:{result.page_number}:block:{block_index}"),
                    document_id=document_id,
                    page_number=result.page_number,
                    block_index=block_index,
                    source_type=block.source_type,
                    text=block.text,
                    bbox=block.bbox,
                    content_hash=hashlib.sha256(block.text.encode("utf-8")).hexdigest(),
                )
            )
        for index, (key, media_type, digest, byte_size) in enumerate(stored_assets, start=1):
            db.add(
                DocumentAsset(
                    id=uuid5(document_id, f"page:{result.page_number}:asset:{index}"),
                    document_id=document_id,
                    page_number=result.page_number,
                    asset_type="figure",
                    object_key=key,
                    media_type=media_type,
                    content_hash=digest,
                    byte_size=byte_size,
                )
            )

        page.status = PageStatus(result.status)
        page.parser = result.parser_name
        page.extracted_text = result.text
        page.text_hash = result.text_hash
        page.char_count = len(result.text)
        page.word_count = len(result.text.split())
        page.block_count = len(result.blocks)
        page.quality_score = result.quality_score
        page.fallback_required = result.fallback_required
        page.fallback_used = result.fallback_used
        page.is_ocr = result.is_ocr
        page.tables_detected = result.tables_detected
        page.formulas_detected = result.formulas_detected
        page.warning = result.warnings + asset_warnings
        page.processed_at = datetime.now(UTC)
        await db.commit()


async def process_document_job(
    payload: dict[str, object],
    engine: AsyncEngine,
    storage: StorageProvider,
    settings: Settings,
    page_number: int | None = None,
) -> None:
    try:
        document_id = UUID(str(payload["document_id"]))
    except (KeyError, ValueError) as exc:
        raise ValueError("Invalid document job payload") from exc
    factory = make_session_factory(engine)
    async with factory() as db:
        document = await db.get(Document, document_id)
        if document is None:
            return
        object_key = document.object_key
        media_type = document.media_type
        filename = document.filename
        document.status = DocumentStatus.PREFLIGHT
        await db.commit()

    suffix = ".pdf" if media_type == "application/pdf" else Path(filename).suffix or ".img"
    fd, raw_path = tempfile.mkstemp(prefix="eas-source-", suffix=suffix)
    os.close(fd)
    source_path = Path(raw_path)
    try:
        await storage.get_file(object_key, source_path)
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="eas-parser")
        loop = asyncio.get_running_loop()
        parser: PageParser | DoclingPageParser | None = None
        try:
            parser = await loop.run_in_executor(
                executor,
                create_parser,
                source_path,
                media_type,
                settings.ocr_language,
                settings.extraction_min_chars,
                settings.parser_backend,
                settings.max_pdf_pages,
            )
            expected_count = await loop.run_in_executor(executor, lambda: parser.page_count)
        except Exception as exc:
            async with factory() as db:
                document = await db.get(Document, document_id)
                if document is not None:
                    document.status = DocumentStatus.FAILED
                    document.completeness_status = "failed"
                    document.warnings = list(document.warnings or []) + [
                        f"PREFLIGHT_FAILED_{type(exc).__name__}"
                    ]
                    await db.commit()
            return
        try:
            if page_number is not None and not 1 <= page_number <= expected_count:
                raise ValueError("Requested page number is outside the document")
            if expected_count < 1:
                async with factory() as db:
                    document = await db.get(Document, document_id)
                    document.expected_page_count = 0
                    document.processed_page_count = 0
                    document.status = DocumentStatus.FAILED
                    document.completeness_status = "failed"
                    document.warnings = ["DOCUMENT_HAS_NO_PAGES"]
                    await db.commit()
                return
            if expected_count > settings.max_pdf_pages:
                async with factory() as db:
                    document = await db.get(Document, document_id)
                    document.expected_page_count = expected_count
                    document.processed_page_count = expected_count
                    document.failed_page_count = expected_count
                    document.status = DocumentStatus.FAILED
                    document.completeness_status = "failed"
                    document.warnings = ["PAGE_LIMIT_EXCEEDED"]
                    await db.commit()
                return

            async with factory() as db:
                document = await db.get(Document, document_id)
                document.expected_page_count = expected_count
                existing_pages = list(
                    (
                        await db.scalars(
                            select(DocumentPage).where(DocumentPage.document_id == document_id)
                        )
                    ).all()
                )
                existing_numbers = {page.page_number for page in existing_pages}
                for number in range(1, expected_count + 1):
                    if number not in existing_numbers:
                        db.add(
                            DocumentPage(
                                id=uuid5(document_id, f"page:{number}"),
                                document_id=document_id,
                                page_number=number,
                                status=PageStatus.PENDING,
                            )
                        )
                await db.commit()

            page_numbers = [page_number] if page_number else list(range(1, expected_count + 1))
            for current_page in page_numbers:
                async with factory() as db:
                    row = await db.scalar(
                        select(DocumentPage).where(
                            DocumentPage.document_id == document_id,
                            DocumentPage.page_number == current_page,
                        )
                    )
                    if row is None:
                        raise RuntimeError("Page inventory row is missing")
                    if page_number is None and row.status == PageStatus.READY:
                        continue
                    row.status = PageStatus.PROCESSING
                    document = await db.get(Document, document_id)
                    document.status = DocumentStatus.PARSING
                    await db.commit()
                try:
                    parsed = await loop.run_in_executor(executor, parser.parse_page, current_page)
                except Exception as exc:
                    parsed = ParsedPage(
                        page_number=current_page,
                        text="",
                        text_hash=hashlib.sha256(b"").hexdigest(),
                        blocks=[],
                        assets=[],
                        quality_score=0.0,
                        status="FAILED",
                        fallback_required=True,
                        fallback_used=False,
                        is_ocr=False,
                        tables_detected=0,
                        formulas_detected=0,
                        warnings=[f"PAGE_EXTRACTION_FAILED_{type(exc).__name__}"],
                    )
                if parsed.fallback_required:
                    async with factory() as db:
                        document = await db.get(Document, document_id)
                        document.status = DocumentStatus.OCR_FALLBACK
                        await db.commit()
                if parsed.assets:
                    async with factory() as db:
                        document = await db.get(Document, document_id)
                        document.status = DocumentStatus.EXTRACTING_ASSETS
                        await db.commit()
                await _persist_page(factory, storage, document_id, parsed)
            async with factory() as db:
                document = await db.get(Document, document_id)
                document.status = DocumentStatus.BUILDING_STRUCTURE
                await db.commit()
                document.status = DocumentStatus.VALIDATING_COVERAGE
                await db.commit()
            await _finish_document(factory, document_id, expected_count)
        finally:
            if parser is not None:
                await loop.run_in_executor(executor, parser.close)
            executor.shutdown(wait=True, cancel_futures=True)
    finally:
        source_path.unlink(missing_ok=True)

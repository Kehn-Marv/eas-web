import hashlib
import mimetypes
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, File, Header, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.responses import Response as EmptyResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from starlette.background import BackgroundTask

from packages.shared.db import make_session_factory
from packages.shared.jobs import QueueCapacityExceeded, ensure_queue_capacity
from packages.shared.models import (
    Document,
    DocumentAsset,
    DocumentPage,
    DocumentStatus,
    Job,
    JobEvent,
    JobStatus,
    LearningSession,
)

router = APIRouter(prefix="/v1")
ALLOWED_SIGNATURES = {
    "application/pdf": (b"%PDF-",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/webp": (b"RIFF",),
}


class SessionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: UUID
    learning_mode: str


class DocumentResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: UUID
    session_id: UUID
    filename: str
    media_type: str
    byte_size: int
    status: DocumentStatus
    job_id: UUID
    duplicate: bool = False
    expected_page_count: int | None = None
    processed_page_count: int = 0
    failed_page_count: int = 0
    pages_needing_fallback: int = 0
    text_char_count: int = 0
    tables_detected: int = 0
    figures_detected: int = 0
    formulas_detected: int = 0
    ocr_page_count: int = 0
    completeness_status: str = "pending"
    index_status: str = "pending"
    index_mode: str = "lexical_only"
    indexed_chunk_count: int = 0
    warnings: list[str] = Field(default_factory=list)


class JobResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: UUID
    job_type: str
    status: JobStatus
    attempt_count: int
    max_attempts: int
    error: str | None = None
    events: list[dict[str, object]] = Field(default_factory=list)


class DocumentBlockResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    block_id: UUID
    block_index: int
    source_type: str
    section_id: UUID | None
    text: str
    bbox: list[float] | None
    content_hash: str


class DocumentAssetResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: UUID
    page_number: int
    asset_type: str
    media_type: str
    byte_size: int


class DocumentPageResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: UUID
    page_number: int
    status: str
    parser: str | None
    text: str
    text_hash: str | None
    char_count: int
    word_count: int
    block_count: int
    quality_score: float
    fallback_required: bool
    fallback_used: bool
    is_ocr: bool
    tables_detected: int
    formulas_detected: int
    warnings: list[str]
    blocks: list[DocumentBlockResponse]
    assets: list[DocumentAssetResponse] = Field(default_factory=list)


class SessionDetailResponse(SessionResponse):
    created_at: datetime
    last_active_at: datetime


def _owner_id(request: Request) -> UUID:
    raw = request.cookies.get("eas_session")
    try:
        if raw is None:
            raise ValueError
        return UUID(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "Create a study session first."},
        ) from exc


def _safe_filename(filename: str | None) -> str:
    name = (filename or "upload").replace("\\", "/").split("/")[-1]
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", name).strip(" .")[:255]
    return name or "upload"


@router.post("/sessions", response_model=SessionResponse, status_code=201)
async def create_session(request: Request, response: Response) -> SessionResponse:
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        session = LearningSession()
        db.add(session)
        await db.commit()
        await db.refresh(session)
    response.set_cookie(
        "eas_session",
        str(session.id),
        httponly=True,
        secure=request.app.state.settings.environment != "development",
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
        path="/",
    )
    return SessionResponse(session_id=session.id, learning_mode=session.learning_mode)


@router.get("/sessions/{session_id}", response_model=SessionDetailResponse)
async def get_session(request: Request, session_id: UUID) -> SessionDetailResponse:
    if _owner_id(request) != session_id:
        raise HTTPException(
            404, detail={"code": "SESSION_NOT_FOUND", "message": "Session not found."}
        )
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        session = await db.get(LearningSession, session_id)
        if session is None:
            raise HTTPException(
                404, detail={"code": "SESSION_NOT_FOUND", "message": "Session not found."}
            )
        return SessionDetailResponse(
            session_id=session.id,
            learning_mode=session.learning_mode,
            created_at=session.created_at,
            last_active_at=session.last_active_at,
        )


@router.post("/documents", response_model=DocumentResponse, status_code=202)
async def upload_document(
    request: Request,
    file: Annotated[UploadFile, File()],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=128)] = None,
) -> DocumentResponse:
    session_id = _owner_id(request)
    settings = request.app.state.settings
    factory = make_session_factory(request.app.state.db_engine)
    filename = _safe_filename(file.filename)
    declared_type = (file.content_type or "").lower().split(";")[0].strip()
    if declared_type not in ALLOWED_SIGNATURES:
        raise HTTPException(
            415,
            detail={
                "code": "UNSUPPORTED_MEDIA_TYPE",
                "message": "Upload a PDF or supported image.",
            },
        )

    hasher = hashlib.sha256()
    size = 0
    prefix = b""
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix="eas-upload-", delete=False) as temp:
            temp_path = Path(temp.name)
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise HTTPException(
                        413,
                        detail={
                            "code": "UPLOAD_TOO_LARGE",
                            "message": "The file exceeds the upload size limit.",
                        },
                    )
                if len(prefix) < 16:
                    prefix += chunk[: 16 - len(prefix)]
                hasher.update(chunk)
                temp.write(chunk)
        signatures = ALLOWED_SIGNATURES[declared_type]
        if not any(signature in prefix for signature in signatures):
            raise HTTPException(
                415,
                detail={
                    "code": "INVALID_FILE_CONTENT",
                    "message": "File content does not match its declared type.",
                },
            )
        if declared_type == "image/webp" and prefix[8:12] != b"WEBP":
            raise HTTPException(
                415,
                detail={"code": "INVALID_FILE_CONTENT", "message": "Invalid WebP file signature."},
            )

        digest = hasher.hexdigest()
        async with factory() as db:
            owner = await db.get(LearningSession, session_id)
            if owner is None:
                raise HTTPException(
                    401, detail={"code": "UNAUTHORIZED", "message": "Study session not found."}
                )
            existing = await db.scalar(
                select(Document).where(
                    Document.session_id == session_id, Document.content_hash == digest
                )
            )
            if existing:
                existing_job = await db.scalar(
                    select(Job).where(Job.payload["document_id"].as_string() == str(existing.id))
                )
                if existing_job:
                    return DocumentResponse(
                        document_id=existing.id,
                        session_id=session_id,
                        filename=existing.filename,
                        media_type=existing.media_type,
                        byte_size=existing.byte_size,
                        status=existing.status,
                        job_id=existing_job.id,
                        duplicate=True,
                        expected_page_count=existing.expected_page_count,
                        processed_page_count=existing.processed_page_count,
                        failed_page_count=existing.failed_page_count,
                        completeness_status=existing.completeness_status,
                        index_status=existing.index_status,
                        index_mode=existing.index_mode,
                        indexed_chunk_count=existing.indexed_chunk_count,
                        warnings=existing.warnings,
                    )
            try:
                await ensure_queue_capacity(
                    db,
                    request.app.state.db_engine.dialect.name,
                    settings.max_queued_jobs,
                )
            except QueueCapacityExceeded as exc:
                raise HTTPException(
                    503,
                    detail={
                        "code": "JOB_QUEUE_FULL",
                        "message": "Background processing is busy. Retry shortly.",
                        "retryable": True,
                    },
                    headers={"Retry-After": "30"},
                ) from exc
            document = Document(
                session_id=session_id,
                filename=filename,
                media_type=declared_type,
                content_hash=digest,
                object_key="",
                byte_size=size,
                status=DocumentStatus.STORING,
            )
            db.add(document)
            await db.flush()
            document_id = document.id
            extension = mimetypes.guess_extension(declared_type) or ".bin"
            if declared_type == "image/jpeg":
                extension = ".jpg"
            object_key = f"documents/{document_id}/original{extension}"
            document.object_key = object_key
            try:
                await request.app.state.storage.put_file(object_key, temp_path, declared_type)
                document.status = DocumentStatus.VALIDATING
                effective_key = (
                    f"{session_id}:{idempotency_key}"
                    if idempotency_key
                    else f"document:{session_id}:{digest}"
                )
                job = Job(
                    job_type="document.ingest",
                    payload={"document_id": str(document_id), "session_id": str(session_id)},
                    idempotency_key=effective_key,
                    status=JobStatus.QUEUED,
                )
                db.add(job)
                await db.flush()
                db.add(
                    JobEvent(
                        job_id=job.id,
                        sequence=1,
                        event_type="queued",
                        status=job.status.value,
                        details={"job_type": job.job_type},
                    )
                )
                await db.commit()
                await db.refresh(document)
                await db.refresh(job)
            except IntegrityError:
                await db.rollback()
                await request.app.state.storage.delete(object_key)
                raced_document = await db.scalar(
                    select(Document).where(
                        Document.session_id == session_id,
                        Document.content_hash == digest,
                    )
                )
                if raced_document is not None:
                    raced_job = await db.scalar(
                        select(Job).where(
                            Job.payload["document_id"].as_string() == str(raced_document.id)
                        )
                    )
                    if raced_job is not None:
                        return DocumentResponse(
                            document_id=raced_document.id,
                            session_id=session_id,
                            filename=raced_document.filename,
                            media_type=raced_document.media_type,
                            byte_size=raced_document.byte_size,
                            status=raced_document.status,
                            job_id=raced_job.id,
                            duplicate=True,
                        )
                raise HTTPException(
                    409,
                    detail={
                        "code": "IDEMPOTENCY_CONFLICT",
                        "message": "That idempotency key was already used.",
                    },
                ) from None
            except Exception:
                await db.rollback()
                await request.app.state.storage.delete(object_key)
                raise
        return DocumentResponse(
            document_id=document.id,
            session_id=session_id,
            filename=filename,
            media_type=declared_type,
            byte_size=size,
            status=document.status,
            job_id=job.id,
            expected_page_count=document.expected_page_count,
            processed_page_count=document.processed_page_count,
            failed_page_count=document.failed_page_count,
            pages_needing_fallback=document.pages_needing_fallback,
            text_char_count=document.text_char_count,
            tables_detected=document.tables_detected,
            figures_detected=document.figures_detected,
            formulas_detected=document.formulas_detected,
            ocr_page_count=document.ocr_page_count,
            completeness_status=document.completeness_status,
            index_status=document.index_status,
            index_mode=document.index_mode,
            indexed_chunk_count=document.indexed_chunk_count,
            warnings=document.warnings,
        )
    finally:
        await file.close()
        if temp_path:
            temp_path.unlink(missing_ok=True)


@router.get("/documents/{document_id}", response_model=DocumentResponse)
async def get_document(request: Request, document_id: UUID) -> DocumentResponse:
    session_id = _owner_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        document = await db.scalar(
            select(Document).where(Document.id == document_id, Document.session_id == session_id)
        )
        if document is None:
            raise HTTPException(
                404, detail={"code": "DOCUMENT_NOT_FOUND", "message": "Document not found."}
            )
        job = await db.scalar(
            select(Job).where(Job.payload["document_id"].as_string() == str(document.id))
        )
        if job is None:
            raise HTTPException(
                404, detail={"code": "JOB_NOT_FOUND", "message": "Processing job not found."}
            )
        return DocumentResponse(
            document_id=document.id,
            session_id=session_id,
            filename=document.filename,
            media_type=document.media_type,
            byte_size=document.byte_size,
            status=document.status,
            job_id=job.id,
            expected_page_count=document.expected_page_count,
            processed_page_count=document.processed_page_count,
            failed_page_count=document.failed_page_count,
            pages_needing_fallback=document.pages_needing_fallback,
            text_char_count=document.text_char_count,
            tables_detected=document.tables_detected,
            figures_detected=document.figures_detected,
            formulas_detected=document.formulas_detected,
            ocr_page_count=document.ocr_page_count,
            completeness_status=document.completeness_status,
            index_status=document.index_status,
            index_mode=document.index_mode,
            indexed_chunk_count=document.indexed_chunk_count,
            warnings=document.warnings,
        )


@router.get("/documents/{document_id}/pages/{page_number}", response_model=DocumentPageResponse)
async def get_document_page(
    request: Request, document_id: UUID, page_number: int
) -> DocumentPageResponse:
    session_id = _owner_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        document = await db.scalar(
            select(Document).where(Document.id == document_id, Document.session_id == session_id)
        )
        page = await db.scalar(
            select(DocumentPage).where(
                DocumentPage.document_id == document_id,
                DocumentPage.page_number == page_number,
            )
        )
        if document is None or page is None:
            raise HTTPException(
                404,
                detail={"code": "DOCUMENT_PAGE_NOT_FOUND", "message": "Document page not found."},
            )
        from packages.shared.models import DocumentBlock

        blocks = list(
            (
                await db.scalars(
                    select(DocumentBlock)
                    .where(
                        DocumentBlock.document_id == document_id,
                        DocumentBlock.page_number == page_number,
                    )
                    .order_by(DocumentBlock.block_index)
                )
            ).all()
        )
        assets = list(
            (
                await db.scalars(
                    select(DocumentAsset)
                    .where(
                        DocumentAsset.document_id == document_id,
                        DocumentAsset.page_number == page_number,
                    )
                    .order_by(DocumentAsset.asset_type, DocumentAsset.id)
                )
            ).all()
        )
        return DocumentPageResponse(
            document_id=document_id,
            page_number=page.page_number,
            status=page.status.value,
            parser=page.parser,
            text=page.extracted_text,
            text_hash=page.text_hash,
            char_count=page.char_count,
            word_count=page.word_count,
            block_count=page.block_count,
            quality_score=page.quality_score,
            fallback_required=page.fallback_required,
            fallback_used=page.fallback_used,
            is_ocr=page.is_ocr,
            tables_detected=page.tables_detected,
            formulas_detected=page.formulas_detected,
            warnings=page.warning,
            blocks=[
                DocumentBlockResponse(
                    block_id=block.id,
                    block_index=block.block_index,
                    source_type=block.source_type,
                    section_id=block.section_id,
                    text=block.text,
                    bbox=block.bbox,
                    content_hash=block.content_hash,
                )
                for block in blocks
            ],
            assets=[
                DocumentAssetResponse(
                    asset_id=asset.id,
                    page_number=asset.page_number,
                    asset_type=asset.asset_type,
                    media_type=asset.media_type,
                    byte_size=asset.byte_size,
                )
                for asset in assets
            ],
        )


@router.post(
    "/documents/{document_id}/pages/{page_number}/reprocess",
    response_model=JobResponse,
    status_code=202,
)
async def reprocess_document_page(
    request: Request,
    document_id: UUID,
    page_number: int,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=128)] = None,
) -> JobResponse:
    session_id = _owner_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        document = await db.scalar(
            select(Document).where(Document.id == document_id, Document.session_id == session_id)
        )
        if document is None:
            raise HTTPException(
                404, detail={"code": "DOCUMENT_NOT_FOUND", "message": "Document not found."}
            )
        page = await db.scalar(
            select(DocumentPage).where(
                DocumentPage.document_id == document_id,
                DocumentPage.page_number == page_number,
            )
        )
        if page is None:
            raise HTTPException(
                404,
                detail={"code": "DOCUMENT_PAGE_NOT_FOUND", "message": "Document page not found."},
            )
        key = (
            f"{session_id}:page-reprocess:{idempotency_key}"
            if idempotency_key
            else f"{session_id}:page-reprocess:{uuid4()}"
        )
        existing_job = await db.scalar(select(Job).where(Job.idempotency_key == key))
        payload = {
            "document_id": str(document_id),
            "session_id": str(session_id),
            "page_number": page_number,
        }
        if existing_job is not None:
            if existing_job.payload != payload:
                raise HTTPException(
                    409,
                    detail={
                        "code": "IDEMPOTENCY_CONFLICT",
                        "message": "That key was used for another operation.",
                    },
                )
            return JobResponse(
                job_id=existing_job.id,
                job_type=existing_job.job_type,
                status=existing_job.status,
                attempt_count=existing_job.attempt_count,
                max_attempts=existing_job.max_attempts,
                error=existing_job.error,
            )
        try:
            await ensure_queue_capacity(
                db,
                request.app.state.db_engine.dialect.name,
                request.app.state.settings.max_queued_jobs,
            )
        except QueueCapacityExceeded as exc:
            raise HTTPException(
                503,
                detail={
                    "code": "JOB_QUEUE_FULL",
                    "message": "Background processing is busy. Retry shortly.",
                    "retryable": True,
                },
                headers={"Retry-After": "30"},
            ) from exc
        job = Job(
            job_type="document.reprocess_page",
            payload=payload,
            idempotency_key=key,
            status=JobStatus.QUEUED,
        )
        db.add(job)
        await db.flush()
        db.add(
            JobEvent(
                job_id=job.id,
                sequence=1,
                event_type="queued",
                status=job.status.value,
                details={"job_type": job.job_type},
            )
        )
        await db.commit()
        await db.refresh(job)
        return JobResponse(
            job_id=job.id,
            job_type=job.job_type,
            status=job.status,
            attempt_count=job.attempt_count,
            max_attempts=job.max_attempts,
            error=job.error,
        )


@router.get("/documents/{document_id}/status", response_model=DocumentResponse)
async def get_document_status(request: Request, document_id: UUID) -> DocumentResponse:
    return await get_document(request, document_id)


@router.get("/documents/{document_id}/assets/{asset_id}")
async def get_document_asset(
    request: Request, document_id: UUID, asset_id: UUID
) -> FileResponse:
    owner_id = _owner_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        asset = await db.scalar(
            select(DocumentAsset)
            .join(Document, Document.id == DocumentAsset.document_id)
            .where(
                DocumentAsset.id == asset_id,
                DocumentAsset.document_id == document_id,
                Document.session_id == owner_id,
            )
        )
        if asset is None:
            raise HTTPException(
                404,
                detail={"code": "ASSET_NOT_FOUND", "message": "Source asset not found."},
            )
        key, media_type = asset.object_key, asset.media_type
    temp = tempfile.NamedTemporaryFile(prefix="eas-asset-", delete=False)
    destination = Path(temp.name)
    temp.close()
    try:
        await request.app.state.storage.get_file(key, destination)
    except Exception as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(
            503,
            detail={
                "code": "ASSET_UNAVAILABLE",
                "message": "Source asset is temporarily unavailable.",
            },
        ) from exc
    return FileResponse(
        destination,
        media_type=media_type,
        filename=f"source-{asset_id}",
        content_disposition_type="inline",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
        background=BackgroundTask(destination.unlink, missing_ok=True),
    )


@router.delete("/documents/{document_id}", status_code=204, response_class=EmptyResponse)
async def delete_document(request: Request, document_id: UUID) -> EmptyResponse:
    session_id = _owner_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        document = await db.scalar(
            select(Document).where(Document.id == document_id, Document.session_id == session_id)
        )
        if document is None:
            return EmptyResponse(status_code=204)
        object_key = document.object_key
        job = await db.scalar(
            select(Job).where(Job.payload["document_id"].as_string() == str(document.id))
        )
        if job and job.status in (JobStatus.QUEUED, JobStatus.RETRYABLE):
            job.status = JobStatus.CANCELLED
        assets = list(
            (
                await db.scalars(
                    select(DocumentAsset).where(DocumentAsset.document_id == document.id)
                )
            ).all()
        )
        await request.app.state.storage.delete(object_key)
        for asset in assets:
            await request.app.state.storage.delete(asset.object_key)
        await db.delete(document)
        await db.commit()
    return EmptyResponse(status_code=204)


@router.get("/jobs/{job_id}", response_model=JobResponse)
async def get_job(request: Request, job_id: UUID) -> JobResponse:
    session_id = _owner_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        job = await db.get(Job, job_id)
        if job is None or str(job.payload.get("session_id")) != str(session_id):
            raise HTTPException(404, detail={"code": "JOB_NOT_FOUND", "message": "Job not found."})
        events = list(
            (
                await db.scalars(
                    select(JobEvent).where(JobEvent.job_id == job.id).order_by(JobEvent.sequence)
                )
            ).all()
        )
        return JobResponse(
            job_id=job.id,
            job_type=job.job_type,
            status=job.status,
            attempt_count=job.attempt_count,
            max_attempts=job.max_attempts,
            error=job.error,
            events=[
                {
                    "sequence": event.sequence,
                    "type": event.event_type,
                    "status": event.status,
                    "created_at": event.created_at.isoformat(),
                }
                for event in events
            ],
        )

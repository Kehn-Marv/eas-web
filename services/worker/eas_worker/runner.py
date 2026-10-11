import asyncio
import json
import logging
import os
import socket
import traceback
from collections.abc import Awaitable, Callable
from uuid import UUID

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

from packages.shared.db import make_engine, make_session_factory
from packages.shared.jobs import (
    JOB_LEASE_RENEW_INTERVAL_SECONDS,
    JOB_LEASE_SECONDS,
    claim_job,
    complete_job,
    fail_job,
    renew_job_lease,
)
from packages.shared.models import Document, DocumentStatus, Job, JobStatus
from packages.shared.storage import make_storage
from services.api.eas_api.config import Settings, get_settings
from services.worker.eas_worker.documents import process_document_job
from services.worker.eas_worker.indexing import index_document

logger = logging.getLogger("eas.worker")
JobHandler = Callable[[dict[str, object]], Awaitable[None]]


class Worker:
    def __init__(
        self,
        handlers: dict[str, JobHandler] | None = None,
        worker_id: str | None = None,
        settings: Settings | None = None,
    ):
        settings = settings or get_settings()
        if settings.environment != "development" and settings.storage_backend != "s3":
            raise RuntimeError("Non-development workers must use persistent S3-compatible storage")
        self.settings = settings
        self.engine = make_engine(settings.database_url.get_secret_value())
        self.sessions = make_session_factory(self.engine)
        self.storage = make_storage(
            settings.storage_backend,
            settings.storage_root,
            settings.s3_bucket,
            settings.aws_region,
            settings.s3_endpoint_url,
        )
        if handlers is None:

            async def document_handler(payload: dict[str, object]) -> None:
                page_number = payload.get("page_number")
                await process_document_job(
                    payload,
                    self.engine,
                    self.storage,
                    self.settings,
                    int(page_number) if page_number is not None else None,
                )

            handlers = {
                "document.ingest": document_handler,
                "document.reprocess_page": document_handler,
                "document.index": lambda payload: index_document(
                    payload, self.engine, self.settings
                ),
            }
        self.handlers = handlers
        self.worker_id = worker_id or f"{socket.gethostname()}-{os.getpid()}"

    async def run_once(self) -> bool:
        async with self.sessions() as session:
            async with session.begin():
                job = await claim_job(
                    session,
                    self.worker_id,
                    max_running_jobs=self.settings.max_running_jobs,
                )
                if job is None:
                    return False
                job_id = job.id
                job_type = job.job_type
                attempt_count = job.attempt_count
                payload = dict(job.payload)

        handler = self.handlers.get(job_type)

        async def keep_lease(stop: asyncio.Event) -> None:
            while True:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=JOB_LEASE_RENEW_INTERVAL_SECONDS)
                    return
                except TimeoutError:
                    async with self.sessions() as session:
                        async with session.begin():
                            renewed = await renew_job_lease(
                                session, job_id, self.worker_id, JOB_LEASE_SECONDS
                            )
                    if not renewed:
                        return

        heartbeat_stop = asyncio.Event()
        heartbeat_task = asyncio.create_task(keep_lease(heartbeat_stop))
        async def instrumented_handler():
            with trace.get_tracer("eas.worker").start_as_current_span("worker.job") as span:
                span.set_attribute("eas.job.id", str(job_id))
                span.set_attribute("eas.job.type", job_type)
                span.set_attribute("eas.worker.id", self.worker_id)
                span.set_attribute("eas.job.attempt", attempt_count)
                if handler is not None:
                    try:
                        result = await handler(payload)
                    except Exception:
                        span.set_status(Status(StatusCode.ERROR))
                        raise
                    span.set_attribute("eas.job.status", "completed")
                    return result
                return None

        handler_task = asyncio.create_task(instrumented_handler())
        try:
            if handler is None:
                raise RuntimeError(f"No handler registered for job type: {job_type}")
            completed, _pending = await asyncio.wait(
                {handler_task, heartbeat_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if heartbeat_task in completed and not handler_task.done():
                handler_task.cancel()
                await asyncio.gather(handler_task, return_exceptions=True)
                logger.error(
                    "Job lease lost",
                    extra={"job_id": str(job_id), "job_type": job_type},
                )
                return True
            await handler_task
        except Exception as exc:
            # Keep document contents, SQL text, exception messages, and secrets out of logs.
            last_frame = traceback.extract_tb(exc.__traceback__)[-1] if exc.__traceback__ else None
            original_error = getattr(exc, "orig", None)
            safe_failure = {
                "event": "eas.worker.job_failed",
                "job_id": str(job_id),
                "job_type": job_type,
                "exception_type": type(exc).__name__,
                "exception_module": type(exc).__module__,
                "failure_function": last_frame.name if last_frame else None,
                "failure_file": os.path.basename(last_frame.filename) if last_frame else None,
                "failure_line": last_frame.lineno if last_frame else None,
                "sqlstate": getattr(original_error, "sqlstate", None)
                or getattr(original_error, "pgcode", None),
                "driver_error_code": getattr(original_error, "code", None),
                "attempt": attempt_count,
            }
            # Emit a content-free diagnostic on stdout, which Rumpty exposes in its
            # runtime log view, so production failures can be diagnosed safely.
            print(json.dumps(safe_failure, separators=(",", ":"), sort_keys=True), flush=True)
            async with self.sessions() as session:
                async with session.begin():
                    await fail_job(session, job_id, self.worker_id, type(exc).__name__)
                    failed_job = await session.get(Job, job_id)
                    attempt_count = failed_job.attempt_count if failed_job is not None else None
                    document_id_for_log = None
                    if failed_job is not None and failed_job.status == JobStatus.FAILED:
                        document_id = failed_job.payload.get("document_id")
                        if document_id:
                            document_id_for_log = str(document_id)
                            try:
                                parsed_document_id = UUID(str(document_id))
                            except ValueError:
                                parsed_document_id = None
                            document = (
                                await session.get(Document, parsed_document_id)
                                if parsed_document_id is not None
                                else None
                            )
                            if document is not None and document.status not in (
                                DocumentStatus.READY,
                                DocumentStatus.DEGRADED,
                                DocumentStatus.FAILED,
                            ):
                                document.status = DocumentStatus.DEGRADED
                                document.completeness_status = "partial"
                                document.warnings = list(document.warnings or []) + [
                                    "PROCESSING_JOB_RETRIES_EXHAUSTED"
                                ]
                            if (
                                document is not None
                                and job_type == "document.index"
                                and document.index_status != "ready"
                            ):
                                document.index_status = "failed"
            logger.error(
                "Job failed",
                extra={
                    "job_id": str(job_id),
                    "job_type": job_type,
                    "exception_type": type(exc).__name__,
                    "attempt_count": attempt_count,
                    "document_id": document_id_for_log,
                },
            )
        else:
            async with self.sessions() as session:
                async with session.begin():
                    await complete_job(session, job_id, self.worker_id)
            logger.info(
                "Job completed",
                extra={"job_id": str(job_id), "job_type": job_type, "status": "completed"},
            )
        finally:
            heartbeat_stop.set()
            heartbeat_task.cancel()
            if not handler_task.done():
                handler_task.cancel()
            await asyncio.gather(heartbeat_task, handler_task, return_exceptions=True)
        return True

    async def run_forever(self, poll_seconds: float = 1.0) -> None:
        try:
            while True:
                if not await self.run_once():
                    await asyncio.sleep(poll_seconds)
        finally:
            await self.engine.dispose()


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    worker = Worker()
    await worker.run_forever()


if __name__ == "__main__":
    asyncio.run(main())

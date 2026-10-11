from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from packages.shared.models import Job, JobEvent, JobStatus

JOB_LEASE_SECONDS = 300
JOB_LEASE_RENEW_INTERVAL_SECONDS = 60


class QueueCapacityExceeded(RuntimeError):
    pass


async def ensure_queue_capacity(session: AsyncSession, dialect: str, maximum: int) -> None:
    """Reject new work above the configured backlog; serialize competing PostgreSQL enqueues."""
    if dialect == "postgresql":
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext('eas-job-queue-capacity'))")
        )
    queued = await session.scalar(
        select(func.count(Job.id)).where(Job.status.in_([JobStatus.QUEUED, JobStatus.RETRYABLE]))
    )
    if queued is not None and queued >= maximum:
        raise QueueCapacityExceeded("The background job queue is full")


async def _append_event(
    session: AsyncSession, job: Job, event_type: str, details: dict[str, object] | None = None
) -> None:
    sequence = (
        await session.scalar(select(func.max(JobEvent.sequence)).where(JobEvent.job_id == job.id))
        or 0
    ) + 1
    session.add(
        JobEvent(
            job_id=job.id,
            sequence=sequence,
            event_type=event_type,
            status=job.status.value,
            worker_id=job.worker_id,
            details=details or {},
        )
    )


async def claim_job(
    session: AsyncSession,
    worker_id: str,
    lease_seconds: int = JOB_LEASE_SECONDS,
    max_running_jobs: int = 4,
) -> Job | None:
    """Claim one available job atomically; PostgreSQL skips work leased by peers."""
    now = datetime.now(UTC)
    stale_before = now - timedelta(seconds=lease_seconds)
    bind = session.get_bind()
    if bind.dialect.name == "postgresql":
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext('eas-job-queue-capacity'))")
        )
    active_jobs = await session.scalar(
        select(func.count(Job.id)).where(
            Job.status == JobStatus.RUNNING,
            Job.locked_at >= stale_before,
        )
    )
    if active_jobs is not None and active_jobs >= max_running_jobs:
        return None
    statement = (
        select(Job)
        .where(
            or_(
                (Job.status.in_([JobStatus.QUEUED, JobStatus.RETRYABLE]))
                & (Job.available_at <= now),
                (Job.status == JobStatus.RUNNING) & (Job.locked_at < stale_before),
            )
        )
        .order_by(Job.available_at, Job.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    job = await session.scalar(statement)
    if job is None:
        return None
    job.status = JobStatus.RUNNING
    job.worker_id = worker_id
    job.locked_at = now
    job.attempt_count += 1
    await session.flush()
    await _append_event(session, job, "claimed", {"attempt_count": job.attempt_count})
    return job


async def renew_job_lease(
    session: AsyncSession, job_id: UUID, worker_id: str, lease_seconds: int = JOB_LEASE_SECONDS
) -> bool:
    """Extend a running lease only while this worker still owns the job."""
    result = await session.execute(
        update(Job)
        .where(
            Job.id == job_id,
            Job.status == JobStatus.RUNNING,
            Job.worker_id == worker_id,
        )
        .values(locked_at=datetime.now(UTC))
    )
    return result.rowcount == 1


async def complete_job(session: AsyncSession, job_id: UUID, worker_id: str) -> bool:
    job = await session.get(Job, job_id)
    if job is None or job.status != JobStatus.RUNNING or job.worker_id != worker_id:
        return False
    job.status = JobStatus.COMPLETED
    job.locked_at = None
    await session.flush()
    await _append_event(session, job, "completed")
    return True


async def fail_job(session: AsyncSession, job_id: UUID, worker_id: str, error: str) -> bool:
    job = await session.get(Job, job_id)
    if job is None or job.status != JobStatus.RUNNING or job.worker_id != worker_id:
        return False
    job.error = error[:2000]
    job.locked_at = None
    job.worker_id = None
    if job.attempt_count >= job.max_attempts:
        job.status = JobStatus.FAILED
    else:
        job.status = JobStatus.RETRYABLE
        delay = min(3600, 2 ** min(job.attempt_count, 10))
        job.available_at = datetime.now(UTC) + timedelta(seconds=delay)
    await session.flush()
    await _append_event(session, job, "failed", {"error_code": job.error})
    return True

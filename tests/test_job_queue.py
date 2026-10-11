import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from packages.shared import models as _models  # noqa: F401
from packages.shared.db import Base
from packages.shared.jobs import (
    QueueCapacityExceeded,
    claim_job,
    complete_job,
    ensure_queue_capacity,
    fail_job,
    renew_job_lease,
)
from packages.shared.models import Job, JobEvent, JobStatus
from services.api.eas_api.config import get_settings
from services.worker.eas_worker import runner
from services.worker.eas_worker.runner import Worker


def test_claim_retry_and_completion():
    async def scenario():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as session:
            async with session.begin():
                job = Job(job_type="test", payload={}, idempotency_key="job-1")
                session.add(job)
        async with sessions() as session:
            async with session.begin():
                claimed = await claim_job(session, "worker-1")
                assert claimed is not None
                assert claimed.status == JobStatus.RUNNING
                job_id = claimed.id
                claimed.locked_at = datetime.now(UTC) - timedelta(hours=1)
        async with sessions() as session:
            async with session.begin():
                assert await renew_job_lease(session, job_id, "worker-1")
        async with sessions() as session:
            async with session.begin():
                assert await claim_job(session, "worker-other") is None
        async with sessions() as session:
            async with session.begin():
                assert await fail_job(session, job_id, "worker-1", "temporary failure")
        async with sessions() as session:
            async with session.begin():
                claimed = await claim_job(session, "worker-2")
                assert claimed is None  # exponential retry delay has not elapsed
        async with sessions() as session:
            async with session.begin():
                job = await session.get(Job, job_id)
                job.available_at = job.created_at
        async with sessions() as session:
            async with session.begin():
                claimed = await claim_job(session, "worker-2")
                assert claimed is not None
                assert claimed.attempt_count == 2
        async with sessions() as session:
            async with session.begin():
                assert await complete_job(session, job_id, "worker-2")
        async with sessions() as session:
            events = list(
                (
                    await session.scalars(
                        select(JobEvent)
                        .where(JobEvent.job_id == job_id)
                        .order_by(JobEvent.sequence)
                    )
                ).all()
            )
            assert [event.event_type for event in events] == [
                "claimed",
                "failed",
                "claimed",
                "completed",
            ]
        await engine.dispose()

    asyncio.run(scenario())


def test_queue_backpressure_and_active_worker_cap():
    async def scenario():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as session:
            async with session.begin():
                session.add(Job(job_type="work", payload={}, idempotency_key="queue-1"))
        async with sessions() as session:
            async with session.begin():
                with pytest.raises(QueueCapacityExceeded):
                    await ensure_queue_capacity(session, "sqlite", maximum=1)
                first = await claim_job(session, "worker-1", max_running_jobs=1)
                assert first is not None
                session.add(Job(job_type="work", payload={}, idempotency_key="queue-2"))
        async with sessions() as session:
            async with session.begin():
                second = await claim_job(session, "worker-2", max_running_jobs=1)
                assert second is None
        await engine.dispose()

    asyncio.run(scenario())


@pytest.mark.asyncio
async def test_worker_renews_lease_while_handler_is_running(tmp_path, monkeypatch):
    database_path = (tmp_path / "worker-lease.db").as_posix()
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{database_path}")
    get_settings.cache_clear()
    renewals = 0
    original_renew = runner.renew_job_lease

    async def count_renewals(*args, **kwargs):
        nonlocal renewals
        renewals += 1
        return await original_renew(*args, **kwargs)

    async def slow_handler(_payload):
        await asyncio.sleep(0.08)

    monkeypatch.setattr(runner, "JOB_LEASE_RENEW_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(runner, "renew_job_lease", count_renewals)
    worker = Worker(handlers={"slow": slow_handler}, worker_id="lease-test-worker")
    try:
        async with worker.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with worker.sessions() as session:
            session.add(Job(job_type="slow", payload={}, idempotency_key="slow-job"))
            await session.commit()

        assert await worker.run_once()
        async with worker.sessions() as session:
            job = await session.scalar(select(Job).where(Job.idempotency_key == "slow-job"))
            assert job is not None and job.status == JobStatus.COMPLETED
        assert renewals >= 1
    finally:
        await worker.engine.dispose()
        get_settings.cache_clear()

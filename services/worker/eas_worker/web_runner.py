"""Run the durable worker with an HTTP health endpoint for web-service hosts."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException

from packages.shared.db import check_database
from infrastructure.scripts.backup_postgres import backup_postgres
from services.worker.eas_worker.runner import Worker

logger = logging.getLogger("eas.worker.health")
BACKUP_INTERVAL_SECONDS = 24 * 60 * 60
BACKUP_RETRY_SECONDS = 60 * 60


async def _periodic_backup() -> None:
    """Write a private production snapshot daily, retrying transient failures hourly."""
    while True:
        try:
            key = await asyncio.to_thread(backup_postgres)
            logger.info("Periodic database backup completed", extra={"backup_key": key})
            await asyncio.sleep(BACKUP_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(
                "Periodic database backup failed",
                extra={"exception_type": type(exc).__name__},
            )
            await asyncio.sleep(BACKUP_RETRY_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    worker = Worker()
    await check_database(worker.engine)
    task = asyncio.create_task(worker.run_forever(), name="eas-durable-worker")
    backup_task = asyncio.create_task(_periodic_backup(), name="eas-database-backup")
    app.state.worker = worker
    app.state.worker_task = task
    app.state.backup_task = backup_task
    app.state.ready = True
    try:
        yield
    finally:
        app.state.ready = False
        task.cancel()
        backup_task.cancel()
        await asyncio.gather(task, backup_task, return_exceptions=True)


app = FastAPI(title="EAS Worker Health", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    task = getattr(app.state, "worker_task", None)
    if not getattr(app.state, "ready", False) or task is None or task.done():
        raise HTTPException(status_code=503, detail="Worker is not running")
    return {"status": "ok"}


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))


if __name__ == "__main__":
    main()

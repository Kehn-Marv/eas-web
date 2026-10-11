"""Create a compressed PostgreSQL dump and upload it to a private S3 bucket."""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import boto3
from botocore.config import Config
from sqlalchemy.engine import make_url

logger = logging.getLogger("eas.backup")


def backup_postgres() -> str:
    database_url = os.environ.get("DATABASE_URL")
    bucket = os.environ.get("BACKUP_BUCKET") or os.environ.get("S3_BUCKET")
    if not database_url or not bucket:
        raise RuntimeError("DATABASE_URL and BACKUP_BUCKET (or S3_BUCKET) are required")

    url = make_url(database_url)
    if url.get_backend_name() != "postgresql":
        raise RuntimeError("DATABASE_URL must use PostgreSQL")
    if not url.host or not url.database:
        raise RuntimeError("DATABASE_URL must include a database host and name")

    process_env = os.environ.copy()
    process_env.update(
        {
            "PGHOST": url.host,
            "PGPORT": str(url.port or 5432),
            "PGDATABASE": url.database,
        }
    )
    if url.username:
        process_env["PGUSER"] = url.username
    if url.password:
        process_env["PGPASSWORD"] = url.password
    sslmode = url.query.get("sslmode") or url.query.get("ssl")
    if isinstance(sslmode, tuple):
        sslmode = sslmode[-1]
    if sslmode:
        process_env["PGSSLMODE"] = str(sslmode)

    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    key = f"backups/eas/postgres-{timestamp}.dump"
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    endpoint_url = os.environ.get("S3_ENDPOINT_URL")

    with tempfile.TemporaryDirectory(prefix="eas-pg-backup-") as temp_dir:
        dump_path = Path(temp_dir) / "database.dump"
        command = [
            "pg_dump",
            "--format=custom",
            "--compress=9",
            "--no-owner",
            "--no-acl",
            f"--file={dump_path}",
        ]
        try:
            subprocess.run(command, env=process_env, check=True, capture_output=True)
            options = {}
            if endpoint_url:
                options["config"] = Config(s3={"addressing_style": "path"})
            client = boto3.client(
                "s3", region_name=region, endpoint_url=endpoint_url, **options
            )
            client.upload_file(str(dump_path), bucket, key)
        except Exception as exc:
            # Do not log subprocess output, connection strings, or exception messages.
            logger.error(
                "backup.failed",
                extra={"exception_type": type(exc).__name__, "backup_key": key},
            )
            raise RuntimeError(f"PostgreSQL backup failed ({type(exc).__name__})") from None

    logger.info("backup.completed", extra={"bucket": bucket, "backup_key": key})
    return key


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    backup_postgres()

"""Restore a PostgreSQL dump into an explicitly isolated validation database."""

from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path

from sqlalchemy.engine import make_url


def _pg_env(url_text: str) -> tuple[dict[str, str], str, str, str]:
    url = make_url(url_text)
    if url.get_backend_name() != "postgresql" or not url.host or not url.database:
        raise ValueError("Restore URLs must identify a PostgreSQL host and database")
    env = os.environ.copy()
    env.update({"PGHOST": url.host, "PGPORT": str(url.port or 5432), "PGDATABASE": url.database})
    if url.username:
        env["PGUSER"] = url.username
    if url.password:
        env["PGPASSWORD"] = url.password
    sslmode = url.query.get("sslmode")
    if isinstance(sslmode, tuple):
        sslmode = sslmode[-1]
    if sslmode:
        env["PGSSLMODE"] = str(sslmode)
    return env, url.host.casefold(), url.database.casefold(), url.drivername


def restore_and_validate(dump: Path) -> None:
    source_text = os.environ.get("SOURCE_DATABASE_URL")
    target_text = os.environ.get("RESTORE_DATABASE_URL")
    if not source_text or not target_text:
        raise RuntimeError("SOURCE_DATABASE_URL and RESTORE_DATABASE_URL are required")
    if os.environ.get("EAS_RESTORE_CONFIRM") != "restore-to-isolated-database":
        raise RuntimeError(
            "Set EAS_RESTORE_CONFIRM=restore-to-isolated-database after creating "
            "an isolated target database"
        )
    source_env, source_host, source_db, _ = _pg_env(source_text)
    target_env, target_host, target_db, _ = _pg_env(target_text)
    if source_host == target_host and source_db == target_db:
        raise RuntimeError("Refusing to restore over the source database")
    if not dump.is_file():
        raise FileNotFoundError(dump)
    subprocess.run(
        [
            "pg_restore",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-acl",
            "--exit-on-error",
            f"--dbname={target_db}",
            str(dump.resolve()),
        ],
        env=target_env,
        check=True,
        capture_output=True,
    )
    query = (
        "SELECT to_regclass('public.sessions') IS NOT NULL, "
        "to_regclass('public.documents') IS NOT NULL, "
        "to_regclass('public.job_events') IS NOT NULL, "
        "to_regclass('public.rate_limit_buckets') IS NOT NULL;"
    )
    check = subprocess.run(
        ["psql", "--no-psqlrc", "--tuples-only", "--no-align", "-c", query],
        env=target_env,
        check=True,
        capture_output=True,
        text=True,
    )
    if check.stdout.strip() != "t|t|t|t":
        raise RuntimeError("Restored database is missing one or more required EAS tables")
    extension = subprocess.run(
        [
            "psql",
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "-c",
            "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector');",
        ],
        env=target_env,
        check=True,
        capture_output=True,
        text=True,
    )
    if extension.stdout.strip() != "t":
        raise RuntimeError("Restored database does not have the pgvector extension")
    del source_env
    print(f"Restore validation passed for isolated database {target_host}/{target_db}.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dump", type=Path, help="PostgreSQL custom-format dump file")
    restore_and_validate(parser.parse_args().dump)


if __name__ == "__main__":
    main()

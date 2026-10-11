import importlib.util
from pathlib import Path

import pytest

_BACKUP_SCRIPT = Path(__file__).parents[1] / "infrastructure" / "scripts" / "backup_postgres.py"
_SPEC = importlib.util.spec_from_file_location("backup_postgres", _BACKUP_SCRIPT)
assert _SPEC is not None and _SPEC.loader is not None
backup_postgres = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(backup_postgres)

_RESTORE_SCRIPT = Path(__file__).parents[1] / "infrastructure" / "scripts" / "restore_postgres.py"
_RESTORE_SPEC = importlib.util.spec_from_file_location("restore_postgres", _RESTORE_SCRIPT)
assert _RESTORE_SPEC is not None and _RESTORE_SPEC.loader is not None
restore_postgres = importlib.util.module_from_spec(_RESTORE_SPEC)
_RESTORE_SPEC.loader.exec_module(restore_postgres)


def test_backup_uses_environment_credentials_and_uploads_dump(monkeypatch):
    captured = {}

    def fake_run(command, *, env, check, capture_output):
        captured["command"] = command
        captured["env"] = env
        captured["check"] = check
        captured["capture_output"] = capture_output
        output = next(
            value.removeprefix("--file=")
            for value in command
            if value.startswith("--file=")
        )
        with open(output, "wb") as stream:
            stream.write(b"compressed dump")

    class FakeS3:
        def upload_file(self, filename, bucket, key):
            captured["upload"] = (bucket, key, open(filename, "rb").read())

    monkeypatch.setattr(backup_postgres.subprocess, "run", fake_run)
    monkeypatch.setattr(backup_postgres.boto3, "client", lambda *args, **kwargs: FakeS3())
    monkeypatch.setenv(
        "DATABASE_URL", "postgresql+asyncpg://backup-user:private-pass@db.example:5433/eas?sslmode=require"
    )
    monkeypatch.setenv("BACKUP_BUCKET", "private-backups")
    monkeypatch.setenv("AWS_REGION", "eu-west-1")

    key = backup_postgres.backup_postgres()

    assert "private-pass" not in " ".join(captured["command"])
    assert captured["env"]["PGPASSWORD"] == "private-pass"
    assert captured["env"]["PGHOST"] == "db.example"
    assert captured["env"]["PGSSLMODE"] == "require"
    assert captured["upload"] == ("private-backups", key, b"compressed dump")
    assert key.startswith("backups/eas/postgres-") and key.endswith(".dump")


def test_backup_requires_postgresql_and_bucket(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite:///local.db")
    monkeypatch.delenv("BACKUP_BUCKET", raising=False)
    monkeypatch.delenv("S3_BUCKET", raising=False)
    with pytest.raises(RuntimeError, match="BACKUP_BUCKET"):
        backup_postgres.backup_postgres()


def test_restore_refuses_to_target_the_source_database(monkeypatch, tmp_path):
    url = "postgresql://restore:secret@db.example/eas"
    monkeypatch.setenv("SOURCE_DATABASE_URL", url)
    monkeypatch.setenv("RESTORE_DATABASE_URL", url)
    monkeypatch.setenv("EAS_RESTORE_CONFIRM", "restore-to-isolated-database")
    with pytest.raises(RuntimeError, match="Refusing to restore"):
        restore_postgres.restore_and_validate(tmp_path / "backup.dump")

    monkeypatch.setenv("DATABASE_URL", "sqlite:///local.db")
    monkeypatch.setenv("S3_BUCKET", "private-backups")
    with pytest.raises(RuntimeError, match="PostgreSQL"):
        backup_postgres.backup_postgres()

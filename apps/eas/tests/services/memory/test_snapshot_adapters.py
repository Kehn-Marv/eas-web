"""Snapshot adapter tests — focus on the partner-conversation bridge.

Partner runtimes persist their conversations as JSONL under
``<admin>/partners/<id>/sessions/*.jsonl`` (a store separate from the
chat-history SQLite DB). ``read_partner_entities`` bridges those files
into the ``partner`` memory surface so they consolidate into L2/L3 like
any other surface, tagged with the originating partner.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from eas.services.memory.snapshot import adapters


class _FakePathService:
    def __init__(self, root: Path) -> None:
        self.workspace_root = root


def _write_session(sessions_dir: Path, key: str, turns: list[tuple[str, str]]) -> None:
    sessions_dir.mkdir(parents=True, exist_ok=True)
    with (sessions_dir / f"{key}.jsonl").open("w", encoding="utf-8") as fh:
        for i, (role, content) in enumerate(turns):
            fh.write(
                json.dumps(
                    {"role": role, "content": content, "timestamp": f"2026-06-16T10:0{i}:00"},
                    ensure_ascii=False,
                )
                + "\n"
            )


# ── Corrupt-file tolerance: skip, warn (with path), keep the rest ────


class _SnapshotPathService(_FakePathService):
    """Fake exposing the notebook / co-writer / book path methods."""

    def get_notebook_dir(self) -> Path:
        return self.workspace_root / "notebook"

    def get_notebook_file(self, notebook_id: str) -> Path:
        return self.get_notebook_dir() / f"{notebook_id}.json"

    def get_notebook_index_file(self) -> Path:
        return self.get_notebook_dir() / "notebooks_index.json"

    def get_book_dir(self) -> Path:
        return self.workspace_root / "book"


@pytest.fixture
def snapshot_tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(adapters, "get_path_service", lambda: _SnapshotPathService(tmp_path))
    return tmp_path


def _warn_records(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        rec.getMessage()
        for rec in caplog.records
        if rec.levelno == logging.WARNING
        and rec.name == "eas.services.memory.snapshot.adapters"
    ]


def test_corrupt_notebook_file_skipped_with_warning(
    snapshot_tree: Path, caplog: pytest.LogCaptureFixture
) -> None:
    index = snapshot_tree / "notebook" / "notebooks_index.json"
    index.parent.mkdir(parents=True)
    index.write_text(
        json.dumps({"notebooks": [{"id": "bad", "name": "Bad"}, {"id": "ok", "name": "Ok"}]}),
        encoding="utf-8",
    )
    corrupt = snapshot_tree / "notebook" / "bad.json"
    corrupt.write_text("{ not json", encoding="utf-8")
    good = snapshot_tree / "notebook" / "ok.json"
    good.write_text(
        json.dumps({"records": [{"id": "r1", "title": "T", "output": "O"}]}),
        encoding="utf-8",
    )

    with caplog.at_level(logging.WARNING):
        entities = adapters.read_notebook_entities()

    assert [e.id for e in entities] == ["r1"]
    warnings = _warn_records(caplog)
    assert any(str(corrupt) in w for w in warnings)


def test_corrupt_book_manifest_skipped_with_warning(
    snapshot_tree: Path, caplog: pytest.LogCaptureFixture
) -> None:
    books = snapshot_tree / "book"
    bad_dir = books / "book_bad"
    bad_dir.mkdir(parents=True)
    corrupt = bad_dir / "manifest.json"
    corrupt.write_text("[ broken", encoding="utf-8")
    good_dir = books / "book_ok"
    good_dir.mkdir()
    (good_dir / "manifest.json").write_text(
        json.dumps({"id": "ok", "title": "Book", "description": "D"}),
        encoding="utf-8",
    )

    with caplog.at_level(logging.WARNING):
        entities = adapters.read_book_entities()

    assert [e.id for e in entities] == ["ok"]
    warnings = _warn_records(caplog)
    assert any(str(corrupt) in w for w in warnings)

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

from eas.services.path_service import PathService
from eas.services.workspace import ContentWorkspaceService

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except Exception:  # pragma: no cover - optional in a minimal installation
    FastAPI = None
    TestClient = None

pytestmark = pytest.mark.skipif(
    FastAPI is None or TestClient is None, reason="fastapi not installed"
)


@pytest.fixture
def workspace_api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    module = importlib.import_module("eas.api.routers.workspace")
    service_module = importlib.import_module("eas.services.workspace.service")
    paths_module = importlib.import_module("eas.multi_user.paths")
    migration_module = importlib.import_module("eas.services.workspace.data_migration")
    paths = PathService(workspace_root=tmp_path / "runtime")
    paths.ensure_all_directories()
    service = ContentWorkspaceService()
    monkeypatch.setattr(service_module, "get_path_service", lambda: paths)
    # The migration lease and recovery journal resolve the account root via
    # separate imports. Keep both in this test's temporary workspace too.
    monkeypatch.setattr(paths_module, "get_account_path_service", lambda: paths)
    monkeypatch.setattr(migration_module, "get_account_path_service", lambda: paths)
    monkeypatch.setattr(migration_module, "get_path_service", lambda: paths)
    monkeypatch.setattr(module, "get_content_workspace_service", lambda: service)
    monkeypatch.delenv("EAS_WORKSPACE_ROOT", raising=False)
    monkeypatch.delenv("EAS_WORKSPACE_ALLOWED_ROOTS", raising=False)

    app = FastAPI()
    from eas.services.workspace.activity import WorkspaceActivityMiddleware

    app.add_middleware(WorkspaceActivityMiddleware)
    app.include_router(module.settings_router, prefix="/api/settings/workspace")
    app.include_router(module.files_router, prefix="/files/workspace-items")
    return TestClient(app), service


def test_workspace_settings_select_and_reset(workspace_api, tmp_path: Path) -> None:
    client, service = workspace_api
    custom = tmp_path / "learning-materials"
    custom.mkdir()

    selected = client.put("/api/settings/workspace", json={"path": str(custom)})
    assert selected.status_code == 200
    assert selected.json()["path"] == str(custom.resolve())
    assert selected.json()["is_default"] is False
    assert service.current_binding().root == custom.resolve()

    reset = client.put("/api/settings/workspace", json={"path": None})
    assert reset.status_code == 200
    assert reset.json()["is_default"] is True


def test_workspace_item_endpoint_serves_the_published_snapshot(workspace_api) -> None:
    client, service = workspace_api
    binding = service.current_binding(ensure_output=True)
    source = binding.root / "notes.md"
    source.write_text("version one", encoding="utf-8")
    item = service.publish(binding, [{"path": "notes.md"}])[0]
    source.write_text("version two", encoding="utf-8")

    response = client.get(item.url)

    assert response.status_code == 200
    assert response.text == "version one"
    assert response.headers["etag"] == f'"{item.sha256}"'
    assert "inline" in response.headers["content-disposition"]
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"].startswith("sandbox;")











def test_workspace_migration_api_blocks_active_turns_and_keeps_bindings(
    workspace_api, tmp_path, monkeypatch
):
    from unittest.mock import AsyncMock

    import eas.services.session as sessions

    client, service = workspace_api
    store = AsyncMock()
    monkeypatch.setattr(sessions, "get_session_store", lambda: store)
    created = client.post("/api/settings/workspace/registrations", json={"name": "Research"})
    assert created.status_code == 200
    row = created.json()["workspace"]
    original = Path(row["path"])
    (original / "notes.txt").write_text("Keep this")
    destination = tmp_path / "new-root"
    store.list_nonterminal_turns.return_value = [{"turn_id": "active"}]
    blocked = client.post(
        "/api/settings/workspace/registrations/migrate-root", json={"path": str(destination)}
    )
    assert blocked.status_code == 409
    assert "running conversations" in blocked.json()["detail"]
    assert store.list_nonterminal_turns.await_count == 1
    assert service.describe_catalog()["migration"] is None
    assert not destination.exists()
    store.list_nonterminal_turns.return_value = []
    moved = client.post(
        "/api/settings/workspace/registrations/migrate-root", json={"path": str(destination)}
    )
    assert moved.status_code == 200
    assert store.list_nonterminal_turns.await_count == 2
    assert moved.json()["root"] == str(destination)
    binding = service.validate_chat_binding(row["workspace_id"])
    assert binding.root == destination / row["workspace_id"]
    assert (binding.root / "notes.txt").read_text() == "Keep this"
    assert (original / "notes.txt").read_text() == "Keep this"
    individual = tmp_path / "independent"
    result = client.post(
        f"/api/settings/workspace/registrations/{row['workspace_id']}/migrate",
        json={"path": str(individual)},
    )
    assert result.status_code == 200
    assert service.validate_chat_binding(row["workspace_id"]).root == individual
    assert client.post("/api/settings/workspace/registrations/system-snapshot").status_code == 200

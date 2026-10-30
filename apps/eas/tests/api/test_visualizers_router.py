from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eas.api.routers import visualizers as visualizers_router
from eas.visualizers.registry import VisualizerRegistry
from eas.visualizers.store import VisualizerStore


def _client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    registry = VisualizerRegistry(
        store=VisualizerStore(
            state_file=tmp_path / "visualizers.json",
        )
    )
    monkeypatch.setattr(
        visualizers_router,
        "get_visualizer_registry",
        lambda: registry,
    )
    app = FastAPI()
    app.include_router(visualizers_router.router, prefix="/api/visualizers")
    return TestClient(app)


def test_visualizer_catalog_install_and_enable_routes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(tmp_path, monkeypatch)
    initial = client.get("/api/visualizers/list").json()["visualizers"]
    assert next(item for item in initial if item["id"] == "geogebra")["installed"] is False

    response = client.post("/api/visualizers/bundled/geogebra/install")
    assert response.status_code == 200
    assert response.json()["status"] == "installed"

    disabled = client.post("/api/visualizers/geogebra/disable")
    assert disabled.status_code == 200
    assert client.post("/api/visualizers/geogebra/enable").status_code == 200

"""Per-user visualizer catalog, lifecycle and sandbox asset routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from eas.visualizers.registry import get_visualizer_registry
from eas.visualizers.store import VisualizerStoreError

router = APIRouter()

def _http_error(exc: VisualizerStoreError) -> HTTPException:
    detail = str(exc)
    if "not found" in detail:
        return HTTPException(status_code=404, detail=detail)
    if "already installed" in detail or "reserved" in detail:
        return HTTPException(status_code=409, detail=detail)
    return HTTPException(status_code=400, detail=detail)


@router.get("/list")
async def list_visualizers() -> dict[str, object]:
    registry = get_visualizer_registry()
    return {
        "schema_version": "eas.visualizer-catalog/v1",
        "visualizers": registry.public_catalog(),
    }


@router.post("/bundled/{visualizer_id}/install")
async def install_bundled(visualizer_id: str) -> dict[str, object]:
    registry = get_visualizer_registry()
    try:
        registry.install_bundled(visualizer_id)
    except VisualizerStoreError as exc:
        raise _http_error(exc) from exc
    plugin = registry.get(visualizer_id)
    return {"status": "installed", "visualizer": plugin.manifest.id if plugin else visualizer_id}


@router.post("/{visualizer_id}/enable")
async def enable_visualizer(visualizer_id: str) -> dict[str, str]:
    registry = get_visualizer_registry()
    try:
        registry.set_enabled(visualizer_id, True)
    except VisualizerStoreError as exc:
        raise _http_error(exc) from exc
    return {"status": "enabled", "visualizer": visualizer_id}


@router.post("/{visualizer_id}/disable")
async def disable_visualizer(visualizer_id: str) -> dict[str, str]:
    registry = get_visualizer_registry()
    try:
        registry.set_enabled(visualizer_id, False)
    except VisualizerStoreError as exc:
        raise _http_error(exc) from exc
    return {"status": "disabled", "visualizer": visualizer_id}


@router.delete("/{visualizer_id}")
async def uninstall_visualizer(visualizer_id: str) -> dict[str, str]:
    registry = get_visualizer_registry()
    try:
        registry.uninstall(visualizer_id)
    except VisualizerStoreError as exc:
        raise _http_error(exc) from exc
    return {"status": "uninstalled", "visualizer": visualizer_id}



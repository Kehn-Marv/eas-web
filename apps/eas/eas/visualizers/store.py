"""Per-user enablement state for the built-in visualization catalog."""

from __future__ import annotations

import json


class VisualizerStoreError(ValueError):
    pass


class VisualizerStore:
    """Persist enabled and installed built-in visualizer IDs."""

    def __init__(self, *, state_file=None) -> None:
        from eas.services.path_service import get_path_service

        self.state_file = state_file or get_path_service().get_settings_file("visualizers.json")

    def state(self) -> dict[str, list[str]]:
        try:
            raw = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            raw = {}
        return {
            "installed": _string_list(raw.get("installed")),
            "disabled": _string_list(raw.get("disabled")),
            "uninstalled": _string_list(raw.get("uninstalled")),
        }

    def save_state(self, state: dict[str, list[str]]) -> None:
        normalized = {
            "installed": sorted(set(_string_list(state.get("installed")))),
            "disabled": sorted(set(_string_list(state.get("disabled")))),
            "uninstalled": sorted(set(_string_list(state.get("uninstalled")))),
        }
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        temp = self.state_file.with_suffix(self.state_file.suffix + ".tmp")
        temp.write_text(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp.replace(self.state_file)

    def set_enabled(self, visualizer_id: str, enabled: bool) -> None:
        state = self.state()
        disabled = set(state["disabled"])
        if enabled:
            disabled.discard(visualizer_id)
        else:
            disabled.add(visualizer_id)
        state["disabled"] = sorted(disabled)
        self.save_state(state)

    def set_bundled_installed(self, visualizer_id: str, installed: bool) -> None:
        state = self.state()
        explicitly_installed = set(state["installed"])
        uninstalled = set(state["uninstalled"])
        disabled = set(state["disabled"])
        if installed:
            explicitly_installed.add(visualizer_id)
            uninstalled.discard(visualizer_id)
            disabled.discard(visualizer_id)
        else:
            explicitly_installed.discard(visualizer_id)
            uninstalled.add(visualizer_id)
            disabled.discard(visualizer_id)
        state["installed"] = sorted(explicitly_installed)
        state["uninstalled"] = sorted(uninstalled)
        state["disabled"] = sorted(disabled)
        self.save_state(state)


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if str(item).strip()]


__all__ = ["VisualizerStore", "VisualizerStoreError"]

"""Allowlisted, non-authoritative configuration snapshots for the system workspace.

Never copy configuration files wholesale. Runtime secrets and credential
references remain in the private configuration stores; snapshots cannot be
loaded back into the application as configuration.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from urllib.parse import urlsplit

from eas.services.file_io import atomic_write_json


def _read(path: Path) -> dict:
    if not path.is_file() or path.is_symlink():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _origin(value: object) -> str:
    try:
        parts = urlsplit(str(value or ""))
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            return ""
        port = f":{parts.port}" if parts.port else ""
        return f"{parts.scheme}://{parts.hostname}{port}"
    except ValueError:
        return ""


def _pick(value: dict, fields: tuple[str, ...]) -> dict:
    return {
        key: value[key] for key in fields if isinstance(value.get(key), (str, int, float, bool))
    }


def build_snapshot(settings: Path) -> dict:
    catalog = _read(settings / "model_catalog.json")
    services = {}
    catalog_services = catalog.get("services")
    for name, service in (catalog_services if isinstance(catalog_services, dict) else {}).items():
        if not isinstance(service, dict):
            continue
        profiles = []
        for profile in service.get("profiles") or []:
            if not isinstance(profile, dict):
                continue
            profiles.append(
                {
                    **_pick(profile, ("id", "name", "binding")),
                    "endpoint_origin": _origin(profile.get("base_url")),
                    "credential_configured": bool(
                        profile.get("api_key") or profile.get("api_key_ref")
                    ),
                    "models": [
                        _pick(model, ("id", "name", "model", "context_window", "enabled"))
                        for model in profile.get("models") or []
                        if isinstance(model, dict)
                    ],
                }
            )
        services[name] = {
            **_pick(service, ("active_profile_id", "active_model_id")),
            "profiles": profiles,
        }
    interface = _pick(
        _read(settings / "interface.json"),
        (
            "language",
            "ui_language",
            "response_language",
            "theme",
            "font_size",
        ),
    )
    system = _pick(
        _read(settings / "system.json"),
        (
            "capability_routing_enabled",
            "chat_response_timeout_seconds",
            "max_upload_size_mb",
            "document_parsing_provider",
        ),
    )
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "read_only_snapshot": True,
        "models": services,
        "interface": interface,
        "system": system,
    }


def write_snapshot(root: Path, settings: Path) -> dict:
    snapshot = build_snapshot(settings)
    folder = root / "settings"
    target = folder / "configuration.json"
    if folder.is_symlink() or target.is_symlink():
        raise ValueError("System snapshot paths cannot be symbolic links.")
    folder.mkdir(parents=True, exist_ok=True)
    atomic_write_json(target, snapshot)
    return snapshot

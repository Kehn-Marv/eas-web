"""Deployment policy for parser installation and model downloads."""

from __future__ import annotations

import os


def runtime_parser_maintenance_allowed() -> bool:
    """Whether this process may install parser packages or download models.

    Runtime installs are useful for local development, but production images
    must contain their parser dependencies and model assets (or use a remote
    parser service). Otherwise a successful install disappears on restart.
    An explicit deployment override is available for controlled maintenance.
    """
    override = os.environ.get("EAS_ALLOW_RUNTIME_PARSER_MAINTENANCE")
    if override is not None:
        return override.strip().lower() in {"1", "true", "yes", "on"}
    return os.environ.get("NODE_ENV", "").strip().lower() != "production"


def local_parser_model_download_allowed(configured: bool) -> bool:
    """Apply the deployment guard to a persisted opt-in for model downloads."""
    return bool(configured) and runtime_parser_maintenance_allowed()


__all__ = [
    "local_parser_model_download_allowed",
    "runtime_parser_maintenance_allowed",
]

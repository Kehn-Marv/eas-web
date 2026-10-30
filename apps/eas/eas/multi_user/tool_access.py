"""Per-user access resolution for optional built-in tools and code execution."""

from __future__ import annotations

from .context import get_current_user
from .grants import load_grant


def _current_grant() -> dict | None:
    """The current user's grant, or ``None`` when unrestricted (admin)."""
    user = get_current_user()
    if user.is_admin:
        return None
    return load_grant(user.id)


def allowed_optional_tools() -> set[str] | None:
    """Whitelist of user-toggleable tool names; ``None`` means unrestricted."""
    grant = _current_grant()
    if grant is None:
        return None
    value = grant.get("enabled_tools")
    if value is None:
        return None
    return {str(name) for name in value}


def exec_override() -> bool | None:
    """Per-user exec override: ``None`` follows the deployment policy."""
    grant = _current_grant()
    if grant is None:
        return None
    value = grant.get("exec_enabled")
    return value if isinstance(value, bool) else None


__all__ = ["allowed_optional_tools", "exec_override"]

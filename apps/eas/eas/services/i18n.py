"""Small runtime i18n helper for backend-facing user messages."""

from __future__ import annotations

from typing import Any


def _parse_language(_language: str | None) -> str:
    return "en"


_MESSAGES: dict[str, dict[str, str]] = {
    "en": {
        "api.content_required": "content is required",
        "api.invalid_channels_config": "Invalid channels config",
        "api.partner_already_exists": "Partner '{name}' already exists",
        "api.partner_not_found": "Partner not found",
        "api.partner_not_found_or_not_running": "Partner not found or not running",
        "api.partner_not_running": "Partner not running",
        "api.partner_stopped_start_required": "Partner is stopped. Start it before chatting.",
        "api.persona_already_exists": "Persona already exists: {name}",
        "api.persona_name_required": "Persona name is required",
        "api.persona_not_found": "Persona not found: {name}",
        "api.soul_already_exists": "Soul '{name}' already exists",
        "api.soul_content_empty": "Custom soul content is empty",
        "api.soul_library_not_found": "Soul '{name}' not found in library",
        "api.soul_not_found": "Soul not found",
        "api.tool_not_found": "Tool '{name}' not found",
        "sandbox.command_blocked": "Error: command blocked by safety guard (dangerous pattern).",
        "sandbox.disabled_for_account": "Code execution is disabled for your account.",
        "sandbox.no_backend": "no sandbox backend available",
    },
}


def current_language(default: str = "en") -> str:
    try:
        from eas.services.settings.interface_settings import get_ui_language

        return _parse_language(get_ui_language(default=default))
    except Exception:
        return _parse_language(default)


def t(key: str, default: str = "", *, language: str | None = None, **kwargs: Any) -> str:
    lang = _parse_language(language) if language else current_language()
    text = _MESSAGES.get(lang, {}).get(key) or _MESSAGES["en"].get(key) or default
    if kwargs:
        try:
            return text.format(**kwargs)
        except (KeyError, IndexError, ValueError):
            return text
    return text


__all__ = ["current_language", "t"]

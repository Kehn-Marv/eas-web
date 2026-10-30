"""
Interface (UI) settings reader.

This is the canonical backend source for user-selected UI language/theme stored in:
  data/user/settings/interface.json
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
import json
import os
from pathlib import Path
import tempfile
import threading
from typing import Any

from eas.services.path_service import get_path_service
from eas.tools.builtin import USER_TOGGLEABLE_TOOL_NAMES

DEFAULT_UI_SETTINGS: dict[str, Any] = {
    # "snow" is the pure-white neutral theme, shown as "Default" in the UI.
    "theme": "snow",
    # When true, TTS verbalizes LaTeX (fractions, powers, Greek). Dollar
    # delimiters are stripped either way so the voice never says "dollar".
    "voice_math_speak": True,
}


_LOCKS_GUARD = threading.Lock()
_LOCKS: dict[str, threading.Lock] = {}

def _settings_lock(path: Path) -> threading.Lock:
    """One lock per settings file, so a write only serialises its own file.

    Keyed by resolved path rather than a single global lock because in a
    multi-user deployment each account has its own ``interface.json``; making
    them contend would serialise unrelated users' preference writes.
    """
    key = os.path.normcase(str(path.resolve()))
    with _LOCKS_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _LOCKS[key] = lock
        return lock


def _interface_settings_file():
    # Resolved on every call so a per-user PathService (set after auth)
    # routes reads to the caller's own ``settings/interface.json`` instead
    # of the admin scope frozen at import time.
    return get_path_service().get_settings_file("interface")


def get_ui_settings() -> dict[str, Any]:
    """
    Read UI settings from interface.json with defaults.

    Returns:
        dict containing the theme and voice preferences.
    """
    settings_file = _interface_settings_file()
    if settings_file.exists():
        try:
            with open(settings_file, encoding="utf-8") as f:
                saved = json.load(f) or {}
            settings = {**DEFAULT_UI_SETTINGS, **saved}
            # Old preference files may still contain fields from the removed
            # language selector. Do not expose or carry them forward.
            settings.pop("language", None)
            settings.pop("response_language", None)
            return settings
        except Exception:
            # On any parse error, fall back to defaults (safe)
            return DEFAULT_UI_SETTINGS.copy()

    return DEFAULT_UI_SETTINGS.copy()


def sanitize_enabled_tools(value: Any) -> list[str]:
    """Normalize saved optional-tool names against the runtime catalog."""

    if not isinstance(value, list):
        return list(USER_TOGGLEABLE_TOOL_NAMES)
    allowed = set(USER_TOGGLEABLE_TOOL_NAMES)
    seen: set[str] = set()
    result: list[str] = []
    for name in value:
        if isinstance(name, str) and name in allowed and name not in seen:
            seen.add(name)
            result.append(name)
    return result


def get_enabled_optional_tools() -> list[str]:
    """Read the current user's enabled tools and apply the admin grant."""

    from eas.multi_user.tool_access import allowed_optional_tools

    enabled = sanitize_enabled_tools(get_ui_settings().get("enabled_optional_tools"))
    allowed = allowed_optional_tools()
    if allowed is not None:
        enabled = [name for name in enabled if name in allowed]
    return enabled


def atomic_update(
    settings_file: Path, mutate: Callable[[dict[str, Any]], Mapping[str, Any]]
) -> dict[str, Any]:
    """Read, mutate and replace a settings file as one indivisible step.

    Takes the path rather than resolving it, so every writer of a given file
    shares one lock even though they resolve the path themselves — the settings
    router and the setup capability both write ``interface.json`` and a lock
    only one of them takes is not a lock. Measured with each module writing
    directly: six router writes racing six capability writes lost every one of
    the router's.

    ``mutate`` receives the raw stored mapping — never the defaults-merged view,
    since writing that back would freeze today's defaults as the user's explicit
    choices — and returns what should be on disk. The write is a temp-file
    rename, so a crash or a full disk leaves the previous file rather than a
    truncated one; a half-written ``interface.json`` is what would drop a user
    back to English and the default theme.
    """
    with _settings_lock(settings_file):
        stored: dict[str, Any] = {}
        if settings_file.exists():
            try:
                with open(settings_file, encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    stored = loaded
            except Exception:
                # A corrupt file is replaced rather than inherited: reads already
                # fall back to defaults, so preserving the broken bytes would only
                # keep the user stuck with settings that do not apply.
                stored = {}
        payload = dict(mutate(stored))
        settings_file.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{settings_file.name}.", suffix=".tmp", dir=settings_file.parent
        )
        temp_path = Path(temp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
                f.write("\n")
                f.flush()
            # Windows may transiently raise PermissionError / access denied on atomic file replace
            for attempt in range(10):
                try:
                    os.replace(temp_path, settings_file)
                    break
                except (PermissionError, OSError):
                    if attempt == 9:
                        raise
                    import time
                    time.sleep(0.005 * (attempt + 1))
        finally:
            temp_path.unlink(missing_ok=True)
        return payload


def update_ui_settings(patch: Mapping[str, Any]) -> dict[str, Any]:
    """Merge ``patch`` into the stored settings, leaving every other field intact.

    Merged into the *raw* stored mapping rather than into
    :func:`get_ui_settings`, whose return value is defaults-merged. Writing that
    merged view back would materialise every current default as an explicit
    stored value, so a user who once changed their theme would silently stop
    following later changes to any other default — the file would already
    contain a frozen copy of the defaults as they were that day.

    Returns the mapping now on disk.
    """
    updates = dict(patch)

    def _mutate(stored: dict[str, Any]) -> dict[str, Any]:
        stored.update(updates)
        return stored

    return atomic_update(_interface_settings_file(), _mutate)


def replace_ui_settings(settings: Mapping[str, Any]) -> dict[str, Any]:
    """Replace the stored settings wholesale (reset, and full-document saves)."""
    payload = dict(settings)
    return atomic_update(_interface_settings_file(), lambda _stored: payload)


def set_ui_setting(key: str, value: Any) -> dict[str, Any]:
    """Persist one field, leaving every other field intact."""
    return update_ui_settings({key: value})


def get_ui_language(default: str = "en") -> str:
    """Return EAS's fixed interface language."""
    del default
    return "en"


def get_response_language(default: str = "en") -> str:
    """Return EAS's fixed model response language."""
    del default
    return "en"

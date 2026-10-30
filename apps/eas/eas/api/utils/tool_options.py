"""Build the configurable first-party tool options exposed by the API."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from eas.i18n.metadata_i18n import localized_description, tool_description_i18n
from eas.services.i18n import current_language

async def build_tool_options(
    *,
    exclude_builtin: set[str] | None = None,
    optional_tools: Iterable[str] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Build the configurable-tool surface.

    ``exclude_builtin`` drops built-in tools from the ``builtin_tools`` list.
    ``optional_tools`` is an optional allow-list for the user-toggleable
    surface. Callers that need a restricted view pass it explicitly.
    """
    from eas.agents._shared.tool_composition import (
        default_optional_tools,
    )
    from eas.runtime.registry.tool_registry import get_tool_registry
    from eas.tools.builtin import CONFIGURABLE_BUILTIN_TOOL_NAMES

    exclude = exclude_builtin or set()

    registry = get_tool_registry()
    language = current_language()

    def _describe(name: str) -> dict[str, Any]:
        tool = registry.get(name)
        description = ""
        if tool is not None:
            try:
                description = tool.get_definition().description or ""
            except Exception:
                description = ""
        descriptions = tool_description_i18n(name, description)
        return {
            "name": name,
            "description": localized_description(descriptions, language),
            "description_i18n": descriptions,
        }

    allowed_optional = None if optional_tools is None else frozenset(optional_tools)
    tools: list[dict[str, Any]] = [
        _describe(name)
        for name in default_optional_tools()
        if allowed_optional is None or name in allowed_optional
    ]
    builtin_tools: list[dict[str, Any]] = [
        _describe(name) for name in CONFIGURABLE_BUILTIN_TOOL_NAMES if name not in exclude
    ]

    return {"tools": tools, "builtin_tools": builtin_tools}


__all__ = ["build_tool_options"]

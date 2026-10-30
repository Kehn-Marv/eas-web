"""Model-facing description of the user Content Workspace."""

from __future__ import annotations

from eas.core.context import UnifiedContext


def workspace_system_note(
    context: UnifiedContext,
    *,
    language: str,
    allow_export: bool = False,
) -> str:
    """Describe only logical workspace paths; never expose host paths."""
    workspace = context.runtime.workspace
    if workspace is None:
        return ""
    output = workspace.logical_output_dir
    export = (
        "If the user explicitly asks to write a result outside outputs/, request one-time "
        "authorization with workspace_export; never try to bypass it."
        if allow_export
        else "Do not write outside outputs/."
    )
    return (
        "[User workspace]\n"
        "Use workspace_list, workspace_search, and workspace_read to inspect files the user "
        "made available. Before saying a local file is unavailable, check with these tools.\n"
        f"The only default writable directory for this turn is `{output}/`. Save every new, "
        "downloaded, extracted, coded, or generated file there. Never expose or guess host "
        "absolute paths.\n"
        "When exec code must open an existing binary workspace file, join the "
        "EAS_WORKSPACE_ROOT environment variable with the exact relative path returned "
        "by a workspace tool; never print the variable's value.\n"
        "To let the user open a file, call workspace_present first, then use the exact relative "
        f"path it returns in Markdown. Never paste an internal download URL. {export}"
    )


__all__ = ["workspace_system_note"]

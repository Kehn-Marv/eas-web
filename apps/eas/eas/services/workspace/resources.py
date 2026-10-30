"""Workspace resource selections. Missing/null selections preserve legacy access.

Selections reference account-owned catalogs; they never contain credentials or
grant access to another account. Runtime consumers apply them after user grants.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator

from eas.services.workspace.models import WorkspaceError


class WorkspaceResources(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skills: list[StrictStr] | None = Field(default=None, max_length=1000)
    knowledge_bases: list[StrictStr] | None = Field(default=None, max_length=1000)

    @field_validator("skills", "knowledge_bases")
    @classmethod
    def clean_ids(cls, values):
        if values is None:
            return None
        if any(not value.strip() or len(value) > 512 for value in values):
            raise ValueError("Resource IDs must contain 1 to 512 characters.")
        return list(dict.fromkeys(value.strip() for value in values))


#: What the running turn picked, as ``{kind: [id, ...]}``. Empty means the
#: conversation picked nothing and inherits the workspace selection.
_turn_selection: ContextVar[dict[str, list[str]]] = ContextVar(
    "turn_resource_selection", default={}
)


@contextmanager
def turn_resource_selection(
    *, skills: list[str] | None = None
) -> Iterator[None]:
    """Narrow the running turn to the skills it selected.

    A turn selection only ever intersects the workspace allowlist: the composer
    lets a conversation read less than its workspace permits, never more. An
    empty (or absent) selection is "inherit", which is what every caller that
    has no picker sends.
    """
    narrowed = {
        kind: list(dict.fromkeys(values))
        for kind, values in (("skills", skills),)
        if values
    }
    token = _turn_selection.set(narrowed)
    try:
        yield
    finally:
        _turn_selection.reset(token)


def _narrow_to_turn(resources: WorkspaceResources) -> WorkspaceResources:
    selection = _turn_selection.get()
    if not selection:
        return resources
    data = resources.model_dump()
    for kind, picked in selection.items():
        allowed = data.get(kind)
        # ``None`` in the workspace row means "everything"; otherwise it is the
        # ceiling this turn's pick is clipped to.
        data[kind] = picked if allowed is None else [v for v in picked if v in set(allowed)]
    return WorkspaceResources.model_validate(data)


def current_resources() -> WorkspaceResources:
    from eas.services.workspace import get_content_workspace_service
    from eas.services.workspace.context import get_workspace_scope

    scope = get_workspace_scope()
    if scope is None:
        return _narrow_to_turn(WorkspaceResources())
    service = get_content_workspace_service()
    workspace_id = scope.workspace_id or service._builtin_id("general")
    row = next((r for r in service._catalog() if r["workspace_id"] == workspace_id), None)
    # Old/default stores need no registration or migration to keep working.
    if row is None:
        if scope.workspace_id:
            raise WorkspaceError("Workspace not found.")
        return _narrow_to_turn(WorkspaceResources())
    # Drop the retired, user-configurable MCP selection when reading old
    # workspace records. It is ignored and removed on the next save.
    stored_resources = dict(row.get("resources") or {})
    stored_resources.pop("mcp", None)
    return _narrow_to_turn(WorkspaceResources.model_validate(stored_resources))


def validate_resources(value, *, previous=None, workspace_id="") -> dict:
    clean_value = dict(value or {})
    clean_value.pop("mcp", None)
    policy = WorkspaceResources.model_validate(clean_value).model_dump()
    catalog = resource_catalog(workspace_id=workspace_id)
    for kind, selected in policy.items():
        if selected is None:
            continue
        known = {item["id"] for item in catalog[kind]}
        # Preserve stale references when editing unrelated settings. A missing
        # resource stays missing; its name must never bind to another origin.
        known.update((previous or {}).get(kind) or [])
        if set(selected) - known:
            raise WorkspaceError(f"Unknown or inaccessible {kind} resource.")
    return policy


def resource_catalog(*, workspace_id: str = "") -> dict:
    from eas.multi_user.context import get_current_user
    from eas.multi_user.paths import current_owner_id
    from eas.services.skill.runtime import skill_sources
    from eas.services.workspace.knowledge import knowledge_catalog

    skills = []
    seen = set()
    for service, allowed, source in skill_sources(workspace_id=workspace_id):
        for info in service.list_skills():
            if info.name in seen or (allowed is not None and info.name not in allowed):
                continue
            seen.add(info.name)
            skills.append(
                {
                    "id": info.name,
                    "name": info.name,
                    "description": info.description,
                    "source": source,
                }
            )

    return {"skills": skills, "knowledge_bases": knowledge_catalog()}


def resource_usage(kind: str, resource_id: str, *, skill_workspace: str = "") -> list[dict]:
    """Account-local impact preview for library edits and deletion."""
    from eas.services.workspace import get_content_workspace_service
    from eas.services.workspace.knowledge import (
        canonical_kb_id,
        move_aliases,
        parse_kb_id,
    )

    if kind not in {"skills", "knowledge_bases"}:
        raise WorkspaceError("Unknown resource type.")
    rows = get_content_workspace_service().list_workspaces()
    result = []
    for row in rows:
        if row["kind"] == "system":
            continue
        selected = (row.get("resources") or {}).get(kind)
        uses = selected is None or resource_id in selected
        if kind == "skills" and skill_workspace:
            uses = uses and row["workspace_id"] == skill_workspace
        if kind == "knowledge_bases" and selected is None:
            parsed = parse_kb_id(resource_id)
            origin = "" if row["kind"] == "general" else row["workspace_id"]
            uses = (
                parsed is None
                or parsed[0] == origin
                or any(
                    (old := parse_kb_id(previous_id)) is not None
                    and old[0] == origin
                    and canonical_kb_id(previous_id) == canonical_kb_id(resource_id)
                    for previous_id in move_aliases()
                )
            )
        if uses:
            result.append(
                {"workspace_id": row["workspace_id"], "display_name": row["display_name"]}
            )
    return result


def knowledge_migration_blockers(source_id: str) -> list[str]:
    """Folder moves preserve identity; aggregate KB moves need unbound references."""
    from eas.services.workspace import get_content_workspace_service

    prefix = f"workspace:{source_id}:kb:" if source_id else "account:kb:"
    names = [
        row["display_name"]
        for row in get_content_workspace_service()._catalog()
        if any(
            rid.startswith(prefix)
            for rid in (row.get("resources") or {}).get("knowledge_bases") or []
        )
    ]
    if not names:
        return []
    return [
        "Knowledge bases are assigned to workspaces: "
        + ", ".join(names)
        + ". Remove these assignments before moving the catalog, or export a copy."
    ]

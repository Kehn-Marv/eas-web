"""Context used while assembling a turn's provider tool view."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ToolScope:
    """Small set of request details needed by provider adapters."""

    session_id: str = ""
    #: Exclusive knowledge capabilities replace the normal provider tool set.
    exclusive_capability: bool = False


__all__ = ["ToolScope"]

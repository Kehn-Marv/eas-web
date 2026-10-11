from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from packages.schemas.visualizations import VisualizationSpec


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["ok"]
    service: str
    environment: str


class ReadinessResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["ready", "not_ready"]
    checks: dict[str, Literal["ok", "failed"]]
    checked_at: datetime


class CitationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: UUID
    page_number: int
    section_id: UUID | None = None
    block_id: UUID
    chunk_id: UUID
    quote_or_excerpt: str
    source_url: str


class GroundedResponse(BaseModel):
    """Stable learner-facing turn response contract."""

    model_config = ConfigDict(extra="forbid")

    turn_id: UUID
    query: str
    text: str
    citations: list[CitationResponse]
    learning_state: dict[str, object] | None = None
    mode: Literal["ADAPTIVE", "INTERACTIVE"] = "ADAPTIVE"
    visualizations: list[VisualizationSpec]
    visualization_ids: list[UUID] = Field(default_factory=list)
    checks: list[dict[str, object]]
    suggested_actions: list[str]
    warnings: list[str]
    trace_id: str

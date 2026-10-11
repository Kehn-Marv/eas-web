"""Safe, versioned visualization specifications rendered by trusted UI components."""

import math
import re
from enum import StrEnum
from typing import Any, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class VisualizationType(StrEnum):
    DIAGRAM = "diagram"
    FLOWCHART = "flowchart"
    CONCEPT_MAP = "concept_map"
    TABLE = "table"
    TIMELINE = "timeline"
    CHART = "chart"
    EQUATION_WALKTHROUGH = "equation_walkthrough"
    PROCESS_SIMULATION = "process_simulation"
    COMPARISON = "comparison"
    GRAPH = "graph"


class VisualizationSourceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: UUID
    page_number: int = Field(ge=1)
    block_id: UUID
    chunk_id: UUID | None = None
    quote_or_excerpt: str | None = Field(default=None, max_length=500)


class VisualElement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
    kind: str = Field(
        pattern=r"^(node|edge|bar|cell|step|label|axis|equation|region|control|point)$"
    )
    label: str = Field(min_length=1, max_length=300)
    data: dict[str, Any] = Field(default_factory=dict)


class InteractionDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
    trigger: str = Field(pattern=r"^(click|select|submit|drag|change)$")
    target_id: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
    action: str = Field(pattern=r"^(select|set|increment|toggle|reorder|submit)$")
    state_key: str | None = Field(default=None, pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
    parameters: dict[str, Any] = Field(default_factory=dict)


class LearningCheckpoint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
    prompt: str = Field(min_length=1, max_length=1000)
    response_type: str = Field(pattern=r"^(multiple_choice|numeric|short_answer|choose_next_step)$")
    expected_answer: str | float | list[str] | None = None

    @model_validator(mode="after")
    def validate_numeric_answer(self) -> Self:
        if isinstance(self.expected_answer, float) and not math.isfinite(self.expected_answer):
            raise ValueError("Checkpoint numeric values must be finite")
        return self


class AccessibilityMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    alt_text: str = Field(min_length=1, max_length=2000)
    text_alternative: str = Field(min_length=1, max_length=5000)
    keyboard_accessible: bool


def _validate_safe_data(value: Any, *, depth: int = 0) -> None:
    if depth > 8:
        raise ValueError("Visualization data nesting exceeds the supported limit")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Visualization numeric values must be finite")
    if isinstance(value, str) and len(value) > 8000:
        raise ValueError("Visualization text value exceeds the supported limit")
    if isinstance(value, dict):
        for key, item in value.items():
            normalized_key = key.casefold().replace("_", "") if isinstance(key, str) else ""
            if not isinstance(key, str) or re.search(
                r"(html|javascript|script|code|url|src)", normalized_key
            ):
                raise ValueError("Executable content and external resources are not allowed")
            _validate_safe_data(item, depth=depth + 1)
    elif isinstance(value, (tuple, list)):
        if len(value) > 1000:
            raise ValueError("Visualization list exceeds the supported limit")
        for item in value:
            _validate_safe_data(item, depth=depth + 1)
    elif not isinstance(value, (str, int, float, bool, type(None))):
        raise ValueError("Visualization data must be JSON-compatible")


class VisualizationSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: str = Field(pattern=r"^1\.0$")
    type: VisualizationType
    title: str = Field(min_length=1, max_length=200)
    pedagogical_goal: str = Field(min_length=1, max_length=1000)
    source_refs: list[VisualizationSourceRef] = Field(min_length=1, max_length=30)
    props: dict[str, Any] = Field(default_factory=dict)
    visual_elements: list[VisualElement] = Field(min_length=1, max_length=250)
    interactions: list[InteractionDefinition] = Field(default_factory=list, max_length=50)
    state_model: dict[str, Any] = Field(default_factory=dict)
    checkpoints: list[LearningCheckpoint] = Field(default_factory=list, max_length=20)
    accessibility: AccessibilityMetadata

    @model_validator(mode="after")
    def validate_spec(self) -> Self:
        element_ids = [element.id for element in self.visual_elements]
        if len(element_ids) != len(set(element_ids)):
            raise ValueError("Visualization element IDs must be unique")
        interaction_ids = [interaction.id for interaction in self.interactions]
        if len(interaction_ids) != len(set(interaction_ids)):
            raise ValueError("Visualization interaction IDs must be unique")
        if any(item.target_id not in element_ids for item in self.interactions):
            raise ValueError("Every interaction must target a defined visual element")
        if any(
            item.action in {"set", "increment", "toggle", "reorder"} and item.state_key is None
            for item in self.interactions
        ):
            raise ValueError("State-changing interactions require a state key")
        for value in (
            self.props,
            self.state_model,
            *(element.data for element in self.visual_elements),
            *(item.parameters for item in self.interactions),
        ):
            _validate_safe_data(value)
        if len(self.model_dump_json()) > 64_000:
            raise ValueError("Visualization spec exceeds the maximum serialized size")
        return self


def validate_source_references(
    spec: VisualizationSpec, available_sources: set[tuple[UUID, int, UUID, UUID | None]]
) -> bool:
    """Require every generated source reference to match a retrieved source object."""
    for reference in spec.source_refs:
        key = (
            reference.document_id,
            reference.page_number,
            reference.block_id,
            reference.chunk_id,
        )
        if (
            key not in available_sources
            and (
                reference.document_id,
                reference.page_number,
                reference.block_id,
                None,
            )
            not in available_sources
        ):
            return False
    return True


def to_json_schema() -> dict[str, object]:
    """Expose the frontend contract schema for validation and code generation."""
    return VisualizationSpec.model_json_schema()

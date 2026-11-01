"""Shared data models for the math animator pipeline."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _as_string_list(value: object) -> list[str]:
    """Accept prose or structured scene objects from LLM JSON output.

    The prompt asks for string arrays, but models sometimes return richer
    objects (for example one object per storyboard scene). Preserve that
    content as readable text instead of failing the entire animation turn.
    """
    if value is None:
        return []
    values = value if isinstance(value, list) else [value]
    result: list[str] = []
    preferred_order = (
        "title", "learning_objective", "visual", "animation_and_transition",
        "narration", "description", "labels", "scene",
    )

    def render(item: object) -> str:
        if isinstance(item, str):
            return item.strip()
        if isinstance(item, dict):
            parts: list[str] = []
            keys = [key for key in preferred_order if key in item]
            keys.extend(key for key in item if key not in keys)
            for key in keys:
                child = item[key]
                text = render(child)
                if not text:
                    continue
                if key == "scene":
                    parts.append(f"Scene {text}")
                elif key == "labels":
                    parts.append(f"Labels: {text}")
                else:
                    label = key.replace("_", " ").capitalize()
                    parts.append(f"{label}: {text}")
            return ". ".join(parts)
        if isinstance(item, list):
            return "; ".join(filter(None, (render(child) for child in item)))
        if isinstance(item, (int, float, bool)):
            return str(item)
        return ""

    for value_item in values:
        text = render(value_item)
        if text:
            result.append(text)
    return result


class ConceptAnalysis(BaseModel):
    model_config = ConfigDict(extra="ignore")

    learning_goal: str = ""
    math_focus: list[str] = Field(default_factory=list)
    visual_targets: list[str] = Field(default_factory=list)
    narrative_steps: list[str] = Field(default_factory=list)
    reference_usage: str = ""
    output_intent: str = ""

    @field_validator("math_focus", "visual_targets", "narrative_steps", mode="before")
    @classmethod
    def normalize_list_content(cls, value: object) -> list[str]:
        return _as_string_list(value)


class SceneDesign(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = ""
    scene_outline: list[str] = Field(default_factory=list)
    visual_style: str = ""
    animation_notes: list[str] = Field(default_factory=list)
    image_plan: list[str] = Field(default_factory=list)
    code_constraints: list[str] = Field(default_factory=list)

    @field_validator(
        "scene_outline", "animation_notes", "image_plan", "code_constraints", mode="before"
    )
    @classmethod
    def normalize_list_content(cls, value: object) -> list[str]:
        return _as_string_list(value)


class GeneratedCode(BaseModel):
    model_config = ConfigDict(extra="ignore")

    code: str = ""
    rationale: str = ""


class SummaryPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    summary_text: str = ""
    user_request: str = ""
    generated_output: str = ""
    key_points: list[str] = Field(default_factory=list)

    @field_validator("key_points", mode="before")
    @classmethod
    def normalize_key_points(cls, value: object) -> list[str]:
        return _as_string_list(value)


class RenderedArtifact(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str
    url: str
    filename: str
    content_type: str = ""
    label: str = ""
    relative_path: str = ""


class RetryAttempt(BaseModel):
    model_config = ConfigDict(extra="ignore")

    attempt: int
    error: str


class VisualReviewResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    passed: bool = True
    summary: str = ""
    issues: list[str] = Field(default_factory=list)
    suggested_fix: str = ""
    reviewed_frames: int = 0


class RenderResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    output_mode: str
    artifacts: list[RenderedArtifact] = Field(default_factory=list)
    public_code_path: str = ""
    source_code_path: str = ""
    quality: str = ""
    retry_attempts: int = 0
    retry_history: list[RetryAttempt] = Field(default_factory=list)
    visual_review: VisualReviewResult | None = None
    workspace_items: list[dict] = Field(default_factory=list)


__all__ = [
    "ConceptAnalysis",
    "GeneratedCode",
    "RenderResult",
    "RenderedArtifact",
    "RetryAttempt",
    "SceneDesign",
    "SummaryPayload",
    "VisualReviewResult",
]

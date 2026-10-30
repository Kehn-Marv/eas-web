"""Localized display metadata for built-in tools and capabilities."""

from __future__ import annotations

_CAPABILITY_DESCRIPTIONS: dict[str, dict[str, str]] = {
    "chat": {
        "en": "Default agentic chat with tools, retrieval, memory, and attachments.",
    },
    "deep_solve": {
        "en": "Multi-step problem solving with planning, reasoning, and final writing.",
    },
    "deep_question": {
        "en": "Generate high-quality questions from templates, sources, or learning goals.",
    },
    "deep_research": {
        "en": "Iterative deep research that decomposes a topic and writes a report.",
    },
    "math_animator": {
        "en": "Generate math animations or storyboard images with Manim.",
    },
    "mastery_path": {
        "en": "Structured mastery-based learning with spaced repetition.",
    },
    "visualize": {
        "en": "Create visual explanations such as SVG, charts, Mermaid, HTML, or Manim.",
    },
    "immersive_reading": {
        "en": "Read a document with the assistant, cited page by page.",
    },
}

_TOOL_DESCRIPTIONS: dict[str, dict[str, str]] = {
    "brainstorm": {
        "en": "Explore ideas broadly and organize them with rationale.",
    },
    "exec": {
        "en": "Run source code or shell scripts inside an isolated workspace.",
    },
    "kb_files": {
        "en": "List the documents a knowledge base holds, with the total count.",
    },
    "paper_search": {
        "en": "Search arXiv preprints and return paper metadata.",
    },
    "reason": {
        "en": "Use a dedicated reasoning model call for hard reasoning tasks.",
    },
    "web_search": {
        "en": "Search the web and return sourced results.",
    },
    "imagegen": {
        "en": "Generate images from a text prompt with the configured model.",
    },
    "videogen": {
        "en": "Generate short videos from a text prompt with the configured model.",
    },
}


def capability_description_i18n(name: str, fallback: str = "") -> dict[str, str]:
    values = _CAPABILITY_DESCRIPTIONS.get(name)
    if values:
        return dict(values)
    return {"en": fallback}


def tool_description_i18n(name: str, fallback: str = "") -> dict[str, str]:
    values = _TOOL_DESCRIPTIONS.get(name)
    if values:
        return dict(values)
    return {"en": fallback}


def localized_description(values: dict[str, str], language: str = "en") -> str:
    return values.get("en") or ""


__all__ = [
    "capability_description_i18n",
    "localized_description",
    "tool_description_i18n",
]

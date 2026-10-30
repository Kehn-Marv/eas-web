"""Shared language directives for prompt-driven LLM calls.

This helper centralizes the "stay in the requested language" instruction so
different modules can share the same behavior without depending on book-only
utilities.
"""

from __future__ import annotations

_LANGUAGE_LABELS: dict[str, str] = {
    "en": "English",
}


def normalize_language(_language: str | None) -> str:
    return "en"


def is_chinese(_language: str | None) -> bool:
    return False


def language_label(_language: str | None) -> str:
    return "English"


def language_directive(language: str | None = None, *, allow_user_override: bool = False) -> str:
    del language, allow_user_override
    body = (
        "\n\n[Language] Write ALL reader-facing text (titles, prose, "
        "explanations, hints, transitions, quiz stems, options, etc.) in "
        "English. Do NOT switch languages even if the source material, "
        "JSON keys, or examples in this prompt are in another language. "
        "Keep proper nouns (people, products, formula symbols) in their "
        "original form."
    )
    return body


def append_language_directive(
    system_prompt: str | None,
    language: str | None,
    *,
    allow_user_override: bool = False,
) -> str:
    """Append the language directive to an existing system prompt."""
    base = (system_prompt or "").rstrip()
    directive = language_directive(language).strip()
    if not base:
        return directive
    return f"{base}\n\n{directive}"


__all__ = [
    "append_language_directive",
    "is_chinese",
    "language_directive",
    "language_label",
    "normalize_language",
]

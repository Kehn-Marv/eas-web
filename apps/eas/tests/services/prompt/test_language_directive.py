"""Tests for the shared English language directive."""

from __future__ import annotations

import pytest

from eas.services.prompt.language import (
    append_language_directive,
    language_directive,
    language_label,
    normalize_language,
)


def test_language_directive_enforces_english() -> None:
    directive = language_directive()
    assert "Write ALL reader-facing text" in directive
    assert "in English" in directive
    assert "Do NOT switch languages" in directive


def test_language_helpers() -> None:
    assert normalize_language("en") == "en"
    assert normalize_language("fr") == "en"
    assert language_label("en") == "English"


def test_append_language_directive() -> None:
    prompt = append_language_directive("## Base\nbody", "en")
    assert prompt.startswith("## Base\nbody")
    assert "in English" in prompt


def test_append_language_directive_empty_base() -> None:
    prompt = append_language_directive(None, "en")
    assert "in English" in prompt


def test_chat_renders_directive() -> None:
    from eas.agents.loop.prompt_blocks import LoopPromptAssembler, PromptBlock

    assembler = LoopPromptAssembler(prompts={}, language="en")
    rendered = assembler.render([PromptBlock(name="Base", content="body")])
    assert "## Base\nbody" in rendered
    assert "in English" in rendered

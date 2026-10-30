"""The ``runtime_context`` block injects the real current date so the model
resolves relative time words (today / this month / now) instead of falling back to
stale training-data dates when composing web_search queries.

Regression guard for the bug where "what is the weather today?" produced a web_search
query with stale dates relative to the real clock.
See ``eas/agents/loop/prompt_blocks.py:_runtime_context_block``.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest
import yaml

from eas.agents.loop import prompt_blocks as prompt_blocks_module
from eas.agents.loop.prompt_blocks import ChatPromptAssembler
from eas.core.context import UnifiedContext

# Deliberately omits ``runtime_context``: exercises the code-default fallback,
# so the date is injected even when a prompt map lacks the entry.
PROMPTS_NO_RUNTIME = {
    "general": "You are EAS.",
    "runtime_policy": "policy",
    "loop": {"system": "loop"},
}

# Naive on purpose: ``datetime.now()`` (which ``_runtime_context_block`` calls)
# returns a naive datetime; ``.astimezone()`` then only attaches the host's
# local timezone without shifting the calendar date. Freezing an aware
# datetime instead made ``astimezone()`` convert across zones, so west-of-UTC
# hosts rendered the frozen instant as the previous day.
FIXED_NOW = datetime(2026, 8, 17, 12)


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        if tz is None:
            return FIXED_NOW
        return FIXED_NOW.astimezone(tz)


@pytest.fixture(autouse=True)
def _freeze_runtime_date(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prompt_blocks_module, "datetime", FrozenDateTime)


def _runtime_block(assembler: ChatPromptAssembler) -> str:
    blocks = assembler.blocks(
        context=UnifiedContext(user_message="what is the weather today?"),
        tool_manifest="- none",
    )
    return next(b.content for b in blocks if b.name == "runtime_context")


def test_block_is_registered():
    assembler = ChatPromptAssembler(prompts=PROMPTS_NO_RUNTIME, language="en")
    names = [
        b.name
        for b in assembler.blocks(context=UnifiedContext(user_message="hi"), tool_manifest="- none")
    ]
    assert "runtime_context" in names


def test_default_injects_real_current_date_en():
    content = _runtime_block(ChatPromptAssembler(prompts=PROMPTS_NO_RUNTIME, language="en"))
    assert "{datetime}" not in content
    assert "2026-08-17" in content


def test_yaml_template_substitutes_placeholder():
    """The shipped yaml template carries ``{datetime}``; the assembler must
    swap it for the real date rather than leaking the raw placeholder."""
    root = Path(__file__).resolve().parents[3] / "eas/agents/chat/prompts"
    prompts = yaml.safe_load((root / "en" / "agentic_chat.yaml").read_text(encoding="utf-8"))
    content = _runtime_block(ChatPromptAssembler(prompts=prompts, language="en"))
    assert "{datetime}" not in content
    assert "2026-08-17" in content


def test_shipped_yaml_carries_runtime_context_template():
    root = Path(__file__).resolve().parents[3] / "eas/agents/chat/prompts"
    for lang in ("en",):
        data = yaml.safe_load((root / lang / "agentic_chat.yaml").read_text(encoding="utf-8"))
        assert "runtime_context" in data, f"{lang} missing runtime_context"
        assert "{datetime}" in data["runtime_context"], (
            f"{lang} runtime_context must keep the {{datetime}} placeholder"
        )

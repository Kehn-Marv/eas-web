from __future__ import annotations

from types import SimpleNamespace

import pytest

from eas.agents.chat.agentic_pipeline import AgenticChatPipeline
from eas.agents.loop.prompt_blocks import ChatPromptAssembler
from eas.capabilities.mastery.pipeline import MasteryLoopPipeline
from eas.core.context import UnifiedContext
from eas.runtime.agentic.tool_dispatch import MAX_PARALLEL_TOOL_CALLS


@pytest.fixture(autouse=True)
def _fake_llm_config(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = SimpleNamespace(
        binding="openai",
        model="gpt-test",
        api_key="sk-test",
        base_url="https://example.test/v1",
        api_version=None,
    )
    monkeypatch.setattr(
        "eas.agents.loop.pipeline.get_llm_config",
        lambda: cfg,
    )
    monkeypatch.setattr("eas.agents.base_agent.get_llm_config", lambda: cfg)


@pytest.mark.parametrize("language", ["en"])
@pytest.mark.parametrize("mode", ["chat", "immersive_reading", "mastery_path"])
def test_tool_call_limit_reaches_each_loop_prompt(language: str, mode: str) -> None:
    pipeline_type = MasteryLoopPipeline if mode == "mastery_path" else AgenticChatPipeline
    pipeline = pipeline_type(language=language)
    context = UnifiedContext(active_capability=mode)
    prompt = pipeline._build_system_prompt([], context)

    assert MAX_PARALLEL_TOOL_CALLS == 15
    assert prompt.count("## tool_call_policy\n") == 1
    assert "{limit}" not in prompt
    assert "at most 15 tool calls" in prompt
    assert "not a total for the user's request" in prompt
    assert "Calls beyond the limit\nare not executed" in prompt


def test_agentic_chat_final_prompt_uses_selected_language(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeRegistry:
        def build_prompt_text(self, *_args, **_kwargs) -> str:
            return "- tool"

    monkeypatch.setattr(
        "eas.agents.loop.pipeline.get_tool_registry",
        lambda: FakeRegistry(),
    )

    from eas.core.context import UnifiedContext

    ctx = UnifiedContext()
    en_prompt = AgenticChatPipeline(language="en")._build_system_prompt([], ctx)

    assert "Write ALL reader-facing text" in en_prompt
    assert "You are EAS" in en_prompt


def test_mastery_plugin_system_prompt_uses_localized_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeRegistry:
        def build_prompt_text(self, *_args, **_kwargs) -> str:
            return "- tool"

    monkeypatch.setattr(
        "eas.agents.loop.pipeline.get_tool_registry",
        lambda: FakeRegistry(),
    )

    from eas.core.context import UnifiedContext

    ctx = UnifiedContext(metadata={"mastery_mode": True, "mastery_path_id": "p1"})
    en_prompt = AgenticChatPipeline(language="en")._build_system_prompt([], ctx)

    assert "## mastery_tutor" in en_prompt
    assert "mastery tutor" in en_prompt


def test_ask_questions_plugin_system_prompt_uses_localized_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeRegistry:
        def build_prompt_text(self, *_args, **_kwargs) -> str:
            return "- tool"

    monkeypatch.setattr(
        "eas.agents.loop.pipeline.get_tool_registry",
        lambda: FakeRegistry(),
    )

    from eas.core.context import UnifiedContext

    ctx = UnifiedContext(metadata={"ask_questions_mode": True})
    en_prompt = AgenticChatPipeline(language="en")._build_system_prompt([], ctx)

    assert "## ask_questions" in en_prompt
    assert "Ask Questions mode" in en_prompt
    assert "second, third, tenth" in en_prompt
    assert "calling `ask_user` exactly once" in en_prompt


def test_prompt_blocks_include_localized_optional_context() -> None:
    from eas.core.context import UnifiedContext

    prompts = {
        "general": "General",
        "runtime_policy": "Policy",
        "loop": {
            "system": "Loop",
            "user": "User says: {user_message}",
            "finish_exhausted": "Budget exhausted, please answer directly.",
        },
    }
    ctx = UnifiedContext(
        user_message="Explain photosynthesis",
        sidebar_context="[Selection]\nLoad code and static data into memory",
        persona_context="Use Socratic questioning",
        memory_context="Student prefers examples",
    )
    assembler = ChatPromptAssembler(prompts=prompts, language="en")

    blocks = assembler.blocks(context=ctx, tool_manifest="", workspace_note="Workspace available")

    names = [block.name for block in blocks]
    assert names[:4] == ["general", "runtime_context", "runtime_policy", "loop"]
    assert "sidebar_tutor_context" in names
    assert "persona_style" in names
    assert "memory" in names
    assert "workspace" in names
    assert assembler.user_message(context=ctx) == "User says: Explain photosynthesis"
    assert assembler.finish_exhausted_instruction() == "Budget exhausted, please answer directly."
    system_prompt = assembler.render(blocks)
    assert "## sidebar_tutor_context" in system_prompt
    assert "Load code and static data into memory" in system_prompt

from __future__ import annotations

from typing import Any

import pytest

from eas.agents.question.agents.followup_agent import FollowupAgent


class CaptureFollowupAgent(FollowupAgent):
    """``FollowupAgent`` subclass that records every system prompt sent to
    the LLM (so the language-directive injection can be asserted), while
    short-circuiting the actual network call."""

    def __init__(self, language: str = "en") -> None:
        self.language = language
        self.prompts: dict[str, Any] = {
            "system": "Followup system",
            "answer_followup": (
                "Question context:\n{question_context}\n\n"
                "Conversation history:\n{history_context}\n\n"
                "User follow-up:\n{user_message}\n"
            ),
        }
        self.captured_system_prompts: list[str] = []

    async def stream_llm(self, **kwargs):  # type: ignore[override]
        self.captured_system_prompts.append(str(kwargs["system_prompt"]))
        yield "Answered"


@pytest.mark.asyncio
async def test_followup_agent_appends_language_directive_to_system_prompt() -> None:
    agent = CaptureFollowupAgent(language="en")

    reply = await agent.process(
        user_message="Why is this the answer?",
        question_context={
            "question_id": "q_1",
            "question_type": "choice",
            "question": "When is matrix multiplication defined?",
            "correct_answer": "When inner dimensions match.",
            "explanation": "Columns of A must equal rows of B.",
        },
        history_context="",
    )

    assert reply == "Answered"
    assert agent.captured_system_prompts
    assert "Followup system" in agent.captured_system_prompts[0]
    assert "English" in agent.captured_system_prompts[0]

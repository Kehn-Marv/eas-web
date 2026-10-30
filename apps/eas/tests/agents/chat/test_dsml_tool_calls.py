"""Tests for the DeepSeek DSML text-format tool-call fallback parser (issue #666)."""

from __future__ import annotations

import json

from eas.agents.loop.dsml_tool_calls import (
    DSMLStreamFilter,
    extract_dsml_tool_calls,
    has_dsml_tool_calls,
)

# The exact markup from the issue report — fullwidth \uff5c special-token bars.
_ISSUE_PAYLOAD = (
    '<\uff5c\uff5cDSML\uff5c\uff5ctool_calls> <\uff5c\uff5cDSML\uff5c\uff5cinvoke name="exec"> '
    '<\uff5c\uff5cDSML\uff5c\uff5cparameter name="command" string="true">'
    "python -c \"from pptx import Presentation; prs=Presentation(); prs.save('test.pptx')\""
    "</\uff5c\uff5cDSML\uff5c\uff5cparameter> </\uff5c\uff5cDSML\uff5c\uff5cinvoke> </\uff5c\uff5cDSML\uff5c\uff5ctool_calls>"
)


def test_extracts_issue_payload_into_tool_call() -> None:
    calls, cleaned = extract_dsml_tool_calls(_ISSUE_PAYLOAD)
    assert len(calls) == 1
    assert calls[0]["name"] == "exec"
    args = json.loads(calls[0]["arguments"])
    assert args["command"].startswith("python -c")
    # All markup consumed — nothing left to masquerade as the answer.
    assert cleaned == ""


def test_extracts_mastery_grade_payload_from_issue_672() -> None:
    # Verbatim markup from issue #672 — DeepSeek grading a Mastery Path
    # answer as DSML text instead of a native tool call.
    text = (
        "<\uff5c\uff5cDSML\uff5c\uff5ctool_calls>\n"
        '<\uff5c\uff5cDSML\uff5c\uff5cinvoke name="mastery_grade">\n'
        '<\uff5c\uff5cDSML\uff5c\uff5cparameter name="answer" string="true">C</\uff5c\uff5cDSML\uff5c\uff5cparameter>\n'
        "</\uff5c\uff5cDSML\uff5c\uff5cinvoke>\n"
        "</\uff5c\uff5cDSML\uff5c\uff5ctool_calls>"
    )
    calls, cleaned = extract_dsml_tool_calls(text)
    assert len(calls) == 1
    assert calls[0]["name"] == "mastery_grade"
    assert json.loads(calls[0]["arguments"]) == {"answer": "C"}
    assert cleaned == ""


def test_multiple_invokes_and_leading_prose() -> None:
    text = (
        "Let me run two steps.\n"
        '<\uff5cDSML\uff5cinvoke name="exec">'
        '<\uff5cDSML\uff5cparameter name="command" string="true">echo one</\uff5cDSML\uff5cparameter>'
        "</\uff5cDSML\uff5cinvoke>"
        '<\uff5cDSML\uff5cinvoke name="read_skill">'
        '<\uff5cDSML\uff5cparameter name="name" string="true">pptx</\uff5cDSML\uff5cparameter>'
        "</\uff5cDSML\uff5cinvoke>"
    )
    calls, cleaned = extract_dsml_tool_calls(text)
    assert [c["name"] for c in calls] == ["exec", "read_skill"]
    assert json.loads(calls[1]["arguments"]) == {"name": "pptx"}
    # Leading prose is preserved; only the markup is stripped.
    assert cleaned == "Let me run two steps."


def test_non_string_parameter_is_json_coerced() -> None:
    text = (
        '<\uff5cDSML\uff5cinvoke name="widget">'
        '<\uff5cDSML\uff5cparameter name="count">3</\uff5cDSML\uff5cparameter>'
        '<\uff5cDSML\uff5cparameter name="label" string="true">3</\uff5cDSML\uff5cparameter>'
        "</\uff5cDSML\uff5cinvoke>"
    )
    calls, _ = extract_dsml_tool_calls(text)
    args = json.loads(calls[0]["arguments"])
    assert args["count"] == 3  # unmarked scalar parsed as JSON
    assert args["label"] == "3"  # string="true" kept verbatim


def test_string_marked_json_containers_follow_tool_schema() -> None:
    text = (
        '<\uff5cDSML\uff5cinvoke name="ask_user">'
        '<\uff5cDSML\uff5cparameter name="questions" string="true">'
        '[{"id":"q1","prompt":"Pick one"}]'
        "</\uff5cDSML\uff5cparameter>"
        '<\uff5cDSML\uff5cparameter name="context" string="true">'
        '{"source":"lesson"}'
        "</\uff5cDSML\uff5cparameter>"
        '<\uff5cDSML\uff5cparameter name="literal" string="true">[not JSON]</\uff5cDSML\uff5cparameter>'
        "</\uff5cDSML\uff5cinvoke>"
    )
    schemas = [
        {
            "type": "function",
            "function": {
                "name": "ask_user",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "questions": {"type": "array", "items": {"type": "object"}},
                        "context": {"type": "object"},
                        "literal": {"type": "string"},
                    },
                },
            },
        }
    ]

    calls, _ = extract_dsml_tool_calls(text, schemas)
    args = json.loads(calls[0]["arguments"])

    assert args["questions"] == [{"id": "q1", "prompt": "Pick one"}]
    assert args["context"] == {"source": "lesson"}
    assert args["literal"] == "[not JSON]"


def test_string_marked_json_container_stays_string_without_schema() -> None:
    text = (
        '<\uff5cDSML\uff5cinvoke name="ask_user">'
        '<\uff5cDSML\uff5cparameter name="questions" string="true">["A", "B"]'
        "</\uff5cDSML\uff5cparameter>"
        "</\uff5cDSML\uff5cinvoke>"
    )

    calls, _ = extract_dsml_tool_calls(text)

    assert json.loads(calls[0]["arguments"])["questions"] == '["A", "B"]'


def test_schema_container_type_must_match_parsed_value() -> None:
    text = (
        '<\uff5cDSML\uff5cinvoke name="ask_user">'
        '<\uff5cDSML\uff5cparameter name="questions" string="true">{"not":"a list"}'
        "</\uff5cDSML\uff5cparameter>"
        "</\uff5cDSML\uff5cinvoke>"
    )
    schemas = [
        {
            "type": "function",
            "function": {
                "name": "ask_user",
                "parameters": {
                    "type": "object",
                    "properties": {"questions": {"type": "array"}},
                },
            },
        }
    ]

    calls, _ = extract_dsml_tool_calls(text, schemas)

    assert json.loads(calls[0]["arguments"])["questions"] == '{"not":"a list"}'


def test_plain_text_is_untouched() -> None:
    text = "Here is your answer. No tools needed."
    assert has_dsml_tool_calls(text) is False
    calls, cleaned = extract_dsml_tool_calls(text)
    assert calls == []
    assert cleaned is text


def test_prose_mentioning_tool_calls_is_not_a_false_positive() -> None:
    # Merely discussing the word must not trip detection — only a real
    # ``<...invoke name="`` / ``<...DSML...>`` tag counts.
    text = "You can trigger tool_calls by asking me to run something."
    assert has_dsml_tool_calls(text) is False
    assert extract_dsml_tool_calls(text) == ([], text)


def test_malformed_envelope_without_close_yields_no_calls() -> None:
    # Signal present but no well-formed invoke block → treat as not-a-DSML-round
    # so the caller falls through unchanged rather than losing the text.
    text = '<\uff5cDSML\uff5cinvoke name="exec"> unterminated ...'
    calls, cleaned = extract_dsml_tool_calls(text)
    assert calls == []
    assert cleaned == text


class TestDSMLStreamFilter:
    @staticmethod
    def _run(chunks: list[str]) -> str:
        stream_filter = DSMLStreamFilter()
        visible = "".join(stream_filter.feed(chunk) for chunk in chunks)
        return visible + stream_filter.flush()

    def test_preserves_prose_before_and_after_call(self) -> None:
        text = (
            "Great job! "
            '<\uff5cDSML\uff5ctool_calls><\uff5cDSML\uff5cinvoke name="ask_user">'
            '<\uff5cDSML\uff5cparameter name="questions" string="true">[]'
            "</\uff5cDSML\uff5cparameter></\uff5cDSML\uff5cinvoke></\uff5cDSML\uff5ctool_calls>"
            " Choose what to study next."
        )

        assert self._run([text]) == "Great job!  Choose what to study next."

    def test_handles_every_split_boundary(self) -> None:
        text = (
            "Before "
            '<\uff5c\uff5cDSML\uff5c\uff5ctool_calls><\uff5c\uff5cDSML\uff5c\uff5cinvoke name="exec">'
            '<\uff5c\uff5cDSML\uff5c\uff5cparameter name="command" string="true">echo hi'
            "</\uff5c\uff5cDSML\uff5c\uff5cparameter></\uff5c\uff5cDSML\uff5c\uff5cinvoke>"
            "</\uff5c\uff5cDSML\uff5c\uff5ctool_calls> after"
        )

        for split_at in range(len(text) + 1):
            assert self._run([text[:split_at], text[split_at:]]) == "Before  after"

        tiny_chunks = [text[index : index + 3] for index in range(0, len(text), 3)]
        assert self._run(tiny_chunks) == "Before  after"

    def test_incomplete_invoke_is_not_silently_discarded(self) -> None:
        text = '<\uff5cDSML\uff5cinvoke name="exec">unterminated'
        assert self._run([text[:8], text[8:]]) == text

    def test_malformed_envelope_is_not_partially_discarded(self) -> None:
        text = "before <\uff5cDSML\uff5ctool_calls>not an invoke after"
        assert self._run([text[:20], text[20:]]) == text

    def test_envelope_without_close_still_cleans_complete_invoke(self) -> None:
        text = 'before <\uff5cDSML\uff5ctool_calls><\uff5cDSML\uff5cinvoke name="exec"></\uff5cDSML\uff5cinvoke> after'
        assert self._run([text[:20], text[20:]]) == "before  after"

    def test_plain_angle_brackets_are_untouched(self) -> None:
        assert self._run(["1 < 2 and <b>", "bold</b>"]) == "1 < 2 and <b>bold</b>"

from __future__ import annotations

from eas.services.session.turn_runtime import _sanitize_session_title


def test_sanitize_session_title_removes_reasoning_block() -> None:
    raw = "<think>\nNeed a concise title.\n</think>\nTitle: AgenticRAG Definition"

    assert _sanitize_session_title(raw) == "AgenticRAG Definition"


def test_sanitize_session_title_falls_back_when_only_reasoning_remains() -> None:
    raw = "<think>\nStill deciding on the title."

    assert _sanitize_session_title(raw) == ""


def test_provider_errors_do_not_become_session_titles() -> None:
    """``llm_stream`` surfaces a provider failure as streamed content.

    A bad key therefore yields a short, well-formed string that the sanitizer
    happily trims and stores as the conversation's name, where it stays forever
    and follows the session into every list that shows it. Routing these to the
    existing "no title" fallback is what makes that impossible.
    """
    from eas.services.session.turn_runtime import _looks_like_error_payload

    assert _looks_like_error_payload(
        "Error: {'message': 'Authentication Fails, Your api key: *** is invalid'}"
    )
    assert _looks_like_error_payload('{"error": {"code": 401}}')
    assert _looks_like_error_payload("Error: call failed")
    assert _looks_like_error_payload("Traceback (most recent call last):")


def test_real_titles_survive_the_error_guard() -> None:
    """A false positive silently replaces a good title with a truncated question."""
    from eas.services.session.turn_runtime import _looks_like_error_payload

    for title in (
        "Operating Systems Overview",
        "Deadlock detection basics",
        "Error handling in Rust",
        "Three patterns of error handling",
        "",
    ):
        assert not _looks_like_error_payload(title), title

"""Tests for learner-facing unicode escape decoding (#973)."""

from __future__ import annotations

from eas.utils.text_display import decode_escaped_unicode_for_display


def test_decodes_dense_non_ascii_runs() -> None:
    escaped = "\\u03b1\\u03b2\\u03b3"
    assert decode_escaped_unicode_for_display(escaped) == "αβγ"


def test_leaves_short_ascii_runs_alone() -> None:
    text = "A JSON string can encode A as \\u0041."
    assert decode_escaped_unicode_for_display(text) == text


def test_empty_and_plain_text_passthrough() -> None:
    assert decode_escaped_unicode_for_display("") == ""
    assert decode_escaped_unicode_for_display("hello") == "hello"


def test_joins_surrogate_pairs_into_one_character() -> None:
    # ``json.dumps`` escapes characters outside the BMP as surrogate pairs.
    escaped = "\\u00e9\\u00e0\\ud83d\\udc4d"
    decoded = decode_escaped_unicode_for_display(escaped)
    assert decoded == "éà👍"


def test_leaves_runs_with_unpaired_surrogates_escaped() -> None:
    text = "\\u00e9\\u00e0\\ud83d"
    assert decode_escaped_unicode_for_display(text) == text

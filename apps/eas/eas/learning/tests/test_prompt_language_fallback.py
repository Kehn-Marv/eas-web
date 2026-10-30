"""Mastery Path prompts resolve to English.

All language requests load en.yaml and append the English directive.
"""

from __future__ import annotations

import pytest

from eas.learning.prompts import (
    get_learning_prompts,
    notebook_generation_prompts,
)


@pytest.mark.parametrize("code", ["ja", "ko", "fr", "de", "ru", "zh", "zh-tw"])
def test_all_languages_land_on_english(code: str) -> None:
    assert get_learning_prompts(code) == get_learning_prompts("en")


def test_notebook_prompts_always_carry_english_directive() -> None:
    en_system, _ = notebook_generation_prompts("en", "[]")
    zh_system, _ = notebook_generation_prompts("zh", "[]")

    assert "in English" in en_system
    assert "in English" in zh_system


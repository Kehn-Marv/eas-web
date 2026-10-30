"""Name a mastery goal from what the learner asked for.

Creating a goal used to take a name as its own field, and dropping that field
left the name derived by truncation: "I want to learn everything about time-series neural networks" became
the title, the subtitle, and the sidebar entry — the same sentence three times,
none of them a name.

A name is a different object from a goal. The goal is a sentence about what the
learner wants; the name is the short label they will pick out of a list months
later. Turning one into the other is exactly the kind of small, frequent,
nobody-asked-for-it call the task model exists to serve — the same class as
conversation titles and starter lines.

Never blocks creation. The call is made once, under a short timeout, and any
failure falls back to the truncated goal — which is what the name was before
this module existed, so the worst case is the previous behaviour rather than a
goal that could not be created.
"""

from __future__ import annotations

import asyncio
import logging
import re

from eas.services.prompt.language import is_chinese as _is_zh

logger = logging.getLogger(__name__)

#: One LLM call at creation time. Long enough for a task model to answer,
#: short enough that a slow provider does not hold up the button.
_TIMEOUT_SECONDS = 8.0
#: A title has to survive a sidebar row and a card heading. A character is not
#: a unit of meaning across scripts, so the budget is per script: 24 CJK
#: characters and 48 Latin ones occupy roughly the same row.
MAX_TITLE_CHARS = 24
MAX_TITLE_CHARS_LATIN = 48
#: Longer than a title and shorter than the goal: this is what the learner is
#: shown when the goal itself is too long to print.
_MAX_GOAL_CHARS = 1_200
#: How many source labels are worth showing. The subject is in the goal; the
#: sources only disambiguate it.
_MAX_SOURCE_LABELS = 6

_SYSTEM_EN = (
    "You name learning goals. Output the name only — no explanation, no "
    "quotes, no trailing punctuation.\n"
    "A name is the short label the learner will recognise in a list months "
    "from now, not a restatement of what they said: name the subject "
    "('Time-series neural networks'), never 'I want to learn...' or "
    "'Everything about...'.\n"
    f"At most {MAX_TITLE_CHARS_LATIN} characters, shorter is better. Use the "
    "learner's own language."
)

# A model that ignores "no quotes" tends to wrap the whole answer in one pair.
_WRAPPING_QUOTES = ('"', "'", "“", "”", "‘", "’")


def _clean(raw: str) -> str:
    """Reduce a model answer to a usable title, or ``""``.

    Rejects rather than repairs anything multi-line: a model that explained
    itself did not answer the question, and taking its first line would put a
    lead-in ("Here is a good name:") on the learner's dashboard.
    """
    text = (raw or "").strip()
    if not text or "\n" in text:
        return ""
    text = text.strip().strip("".join(_WRAPPING_QUOTES)).strip()
    # A trailing full stop is punctuation on a sentence, and this is not one.
    text = re.sub(r"[.!?:;,]+$", "", text).strip()
    if not text:
        return ""
    return _fit(text)


def _fit(text: str) -> str:
    """Trim to this script's budget, on a word boundary where one exists."""
    limit = MAX_TITLE_CHARS_LATIN
    if len(text) <= limit:
        return text
    clipped = text[:limit]
    if " " in clipped:
        head, _, _tail = clipped.rpartition(" ")
        if head.strip():
            return head.strip()
    return clipped.strip()


def _render(goal: str, source_labels: list[str]) -> str:
    lines = ["Learning goal:", goal.strip()[:_MAX_GOAL_CHARS]]
    labels = [label.strip() for label in source_labels if label and label.strip()]
    if labels:
        lines.append("")
        lines.append("Materials:")
        lines.extend(f"- {label}" for label in labels[:_MAX_SOURCE_LABELS])
    return "\n".join(lines)


async def suggest_topic_name(
    goal: str,
    *,
    source_labels: list[str] | None = None,
    language: str = "",
) -> str:
    """A short name for this goal, or ``""`` when one could not be written.

    ``""`` is a real answer, not an error: the caller already has a fallback,
    and a goal that cannot be named still has to be creatable.
    """
    cleaned_goal = (goal or "").strip()
    if not cleaned_goal:
        return ""

    try:
        from eas.services.llm import complete
        from eas.services.model_selection.tasks import TaskKind, task_llm_scope

        # Same call class as conversation titles: short, frequent, and nobody
        # asked for it — so it runs on the task model when one is configured.
        with task_llm_scope(TaskKind.MASTERY_GOAL_NAME):
            raw = await asyncio.wait_for(
                complete(
                    prompt=_render(cleaned_goal, source_labels or []),
                    system_prompt=_SYSTEM_EN,
                    temperature=0.3,
                    max_tokens=60,
                    max_retries=0,
                ),
                timeout=_TIMEOUT_SECONDS,
            )
    except asyncio.TimeoutError:
        logger.debug("topic naming timed out")
        return ""
    except Exception:
        logger.debug("topic naming failed", exc_info=True)
        return ""
    return _clean(str(raw or ""))


__all__ = ["MAX_TITLE_CHARS", "MAX_TITLE_CHARS_LATIN", "suggest_topic_name"]

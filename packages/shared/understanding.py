"""Small deterministic answer evaluator for understanding checks."""

import math
import re
from hashlib import sha256

SUPPORTED_CHECK_TYPES = {
    "multiple_choice",
    "choose_next_step",
    "identify_relationship",
    "reorder_steps",
    "numeric",
    "short_answer",
}
_CHECK_STOP_WORDS = {
    "about",
    "after",
    "also",
    "because",
    "between",
    "could",
    "does",
    "from",
    "have",
    "into",
    "more",
    "most",
    "other",
    "over",
    "same",
    "some",
    "such",
    "than",
    "that",
    "their",
    "there",
    "these",
    "they",
    "this",
    "through",
    "under",
    "using",
    "which",
    "while",
    "with",
}


def build_source_recall_check(query: str, hit) -> dict[str, object] | None:
    """Plan a bounded cloze check from one retrieved source span."""
    excerpt = " ".join(hit.content.split())[:1500]
    matches = [
        match
        for match in re.finditer(r"\b[A-Za-z][A-Za-z'-]{3,}\b", excerpt)
        if match.group().casefold() not in _CHECK_STOP_WORDS
    ]
    if not matches:
        return None
    target = max(matches, key=lambda match: len(match.group()))
    answer = target.group().strip("'-")
    if len(answer) < 4:
        return None
    masked = excerpt[: target.start()] + "_____" + excerpt[target.end() :]
    concept_id = f"source-{sha256(' '.join(query.casefold().split()).encode()).hexdigest()[:24]}"
    return {
        "concept_id": concept_id,
        "check_type": "short_answer",
        "question": f"Complete the statement from your study material: {masked}",
        "expected_answer": answer,
        "tolerance": 0.0,
        "source_refs": [
            {
                "document_id": str(hit.document_id),
                "page_number": hit.page_number,
                "block_id": str(hit.block_id),
            }
        ],
        "representation_used": "visual_with_micro_check",
    }


def normalize_answer(value: object) -> object:
    if isinstance(value, str):
        return " ".join(re.sub(r"\s+", " ", value).strip().casefold().split())
    if isinstance(value, list):
        return [normalize_answer(item) for item in value]
    return value


def evaluate_answer(
    check_type: str, expected: object, answer: object, tolerance: float = 0
) -> bool:
    if check_type not in SUPPORTED_CHECK_TYPES:
        raise ValueError("Unsupported understanding check type")
    if check_type == "numeric":
        try:
            expected_number, answer_number = float(expected), float(answer)
        except (TypeError, ValueError):
            return False
        return (
            math.isfinite(expected_number)
            and math.isfinite(answer_number)
            and abs(expected_number - answer_number) <= max(0.0, tolerance)
        )
    return normalize_answer(expected) == normalize_answer(answer)

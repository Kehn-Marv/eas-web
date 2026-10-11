"""Deterministic learning-friction scoring and representation policy."""

from dataclasses import dataclass
from enum import IntEnum


@dataclass(frozen=True)
class FrictionSignals:
    explicit_confusion: bool = False
    repeated_concept_questions: int = 0
    failed_checkpoints: int = 0
    confidence: float | None = None
    visual_request: bool = False
    procedural_or_complex_topic: bool = False
    recent_explanation_failure: bool = False


@dataclass(frozen=True)
class FrictionWeights:
    explicit_confusion: float = 0.22
    repeated_questions: float = 0.18
    failed_checkpoints: float = 0.20
    low_confidence: float = 0.12
    visual_request: float = 0.10
    topic_complexity: float = 0.06
    recent_failure: float = 0.12


DEFAULT_FRICTION_WEIGHTS = FrictionWeights()


class RepresentationLevel(IntEnum):
    NORMAL = 0
    OFFER_VISUAL = 1
    VISUAL_INTERVENTION = 2
    VISUAL_AND_MICRO_CHECK = 3


@dataclass(frozen=True)
class AdaptiveDecision:
    score: float
    level: RepresentationLevel
    representation: str
    reason_codes: tuple[str, ...]


def score_learning_friction(
    signals: FrictionSignals, weights: FrictionWeights = DEFAULT_FRICTION_WEIGHTS
) -> tuple[float, tuple[str, ...]]:
    """Return a bounded 0..1 score and deterministic signal reason codes."""
    values = {
        "EXPLICIT_CONFUSION": float(signals.explicit_confusion),
        "REPEATED_CONCEPT": min(max(signals.repeated_concept_questions, 0) / 3, 1),
        "FAILED_CHECKPOINT": min(max(signals.failed_checkpoints, 0) / 2, 1),
        "LOW_CONFIDENCE": (
            max(0.0, min(1.0, 0.5 - signals.confidence)) / 0.5
            if signals.confidence is not None
            else 0.0
        ),
        "VISUAL_REQUEST": float(signals.visual_request),
        "COMPLEX_TOPIC": float(signals.procedural_or_complex_topic),
        "RECENT_EXPLANATION_FAILURE": float(signals.recent_explanation_failure),
    }
    contributions = (
        values["EXPLICIT_CONFUSION"] * weights.explicit_confusion,
        values["REPEATED_CONCEPT"] * weights.repeated_questions,
        values["FAILED_CHECKPOINT"] * weights.failed_checkpoints,
        values["LOW_CONFIDENCE"] * weights.low_confidence,
        values["VISUAL_REQUEST"] * weights.visual_request,
        values["COMPLEX_TOPIC"] * weights.topic_complexity,
        values["RECENT_EXPLANATION_FAILURE"] * weights.recent_failure,
    )
    total_weight = sum(
        (
            weights.explicit_confusion,
            weights.repeated_questions,
            weights.failed_checkpoints,
            weights.low_confidence,
            weights.visual_request,
            weights.topic_complexity,
            weights.recent_failure,
        )
    )
    score = min(1.0, max(0.0, sum(contributions) / total_weight))
    reasons = tuple(code for code, value in values.items() if value > 0)
    return score, reasons


def choose_representation(
    score: float,
    *,
    low_threshold: float = 0.25,
    medium_threshold: float = 0.45,
    high_threshold: float = 0.70,
    previous_level: RepresentationLevel = RepresentationLevel.NORMAL,
    turns_since_change: int = 999,
    cooldown_turns: int = 2,
    hysteresis: float = 0.08,
) -> RepresentationLevel:
    if not 0 <= low_threshold < medium_threshold < high_threshold <= 1:
        raise ValueError("Adaptive thresholds must increase within [0, 1]")
    if min(cooldown_turns, turns_since_change) < 0:
        raise ValueError("Turn counts cannot be negative")
    target = (
        RepresentationLevel.VISUAL_AND_MICRO_CHECK
        if score >= high_threshold
        else RepresentationLevel.VISUAL_INTERVENTION
        if score >= medium_threshold
        else RepresentationLevel.OFFER_VISUAL
        if score >= low_threshold
        else RepresentationLevel.NORMAL
    )
    if target >= previous_level:
        return target
    if turns_since_change < cooldown_turns:
        return previous_level
    exit_thresholds = {
        RepresentationLevel.VISUAL_AND_MICRO_CHECK: high_threshold - hysteresis,
        RepresentationLevel.VISUAL_INTERVENTION: medium_threshold - hysteresis,
        RepresentationLevel.OFFER_VISUAL: low_threshold - hysteresis,
    }
    if score >= exit_thresholds.get(previous_level, 0):
        return previous_level
    return target


def adaptive_decision(
    signals: FrictionSignals,
    *,
    weights: FrictionWeights = DEFAULT_FRICTION_WEIGHTS,
    previous_level: RepresentationLevel = RepresentationLevel.NORMAL,
    turns_since_change: int = 999,
    thresholds: tuple[float, float, float] = (0.25, 0.45, 0.70),
    cooldown_turns: int = 2,
    hysteresis: float = 0.08,
) -> AdaptiveDecision:
    score, reasons = score_learning_friction(signals, weights)
    level = choose_representation(
        score,
        low_threshold=thresholds[0],
        medium_threshold=thresholds[1],
        high_threshold=thresholds[2],
        previous_level=previous_level,
        turns_since_change=turns_since_change,
        cooldown_turns=cooldown_turns,
        hysteresis=hysteresis,
    )
    representations = {
        RepresentationLevel.NORMAL: "normal_response",
        RepresentationLevel.OFFER_VISUAL: "offer_visual_support",
        RepresentationLevel.VISUAL_INTERVENTION: "visual_intervention",
        RepresentationLevel.VISUAL_AND_MICRO_CHECK: "visual_with_micro_check",
    }
    return AdaptiveDecision(score, level, representations[level], reasons)

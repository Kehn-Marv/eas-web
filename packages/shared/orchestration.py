"""Explicit shortest-path request orchestration using deterministic classification."""

import re
from dataclasses import dataclass, replace
from typing import Protocol

from packages.shared.adaptive import (
    AdaptiveDecision,
    FrictionSignals,
    RepresentationLevel,
    adaptive_decision,
)


class AdaptiveSettings(Protocol):
    adaptive_low_threshold: float
    adaptive_medium_threshold: float
    adaptive_high_threshold: float
    adaptive_cooldown_turns: int
    adaptive_hysteresis: float


@dataclass(frozen=True)
class RequestClassification:
    conceptual: bool
    explicit_confusion: bool
    explicit_visual_request: bool
    procedural: bool


@dataclass(frozen=True)
class OrchestrationPlan:
    classification: RequestClassification
    decision: AdaptiveDecision
    steps: tuple[str, ...]


def classify_request(query: str) -> RequestClassification:
    lowered = query.casefold()
    return RequestClassification(
        conceptual=bool(re.search(r"\b(why|explain|concept|what is|how does)\b", lowered)),
        explicit_confusion=bool(
            re.search(
                r"\b(confus(?:ed|ing)?|don't understand|do not understand|lost|unclear)\b", lowered
            )
        ),
        explicit_visual_request=bool(
            re.search(r"\b(show|draw|visual|diagram|graph|picture|illustrate)\b", lowered)
        ),
        procedural=bool(
            re.search(
                r"\b(steps?|process|procedure|calculate|derive|prove|walk me through)\b", lowered
            )
        ),
    )


def plan_request(
    query: str,
    settings: AdaptiveSettings,
    *,
    repeated_concept_questions: int = 0,
    failed_checkpoints: int = 0,
    confidence: float | None = None,
    explicit_visual_request: bool = False,
) -> OrchestrationPlan:
    classification = classify_request(query)
    if explicit_visual_request and not classification.explicit_visual_request:
        classification = replace(classification, explicit_visual_request=True)
    decision = adaptive_decision(
        FrictionSignals(
            explicit_confusion=classification.explicit_confusion,
            repeated_concept_questions=repeated_concept_questions,
            failed_checkpoints=failed_checkpoints,
            confidence=confidence,
            visual_request=classification.explicit_visual_request,
            procedural_or_complex_topic=classification.procedural,
        ),
        thresholds=(
            settings.adaptive_low_threshold,
            settings.adaptive_medium_threshold,
            settings.adaptive_high_threshold,
        ),
        cooldown_turns=settings.adaptive_cooldown_turns,
        hysteresis=settings.adaptive_hysteresis,
    )
    if classification.explicit_visual_request and decision.level.value == 0:
        decision = AdaptiveDecision(
            score=decision.score,
            level=RepresentationLevel.OFFER_VISUAL,
            representation="offer_visual_support",
            reason_codes=decision.reason_codes,
        )
    steps = ["request_classification", "query_planning", "retrieval"]
    if classification.conceptual or classification.explicit_confusion:
        steps.append("learning_need")
        steps.append("explanation_planning")
    steps.extend(["content_generation", "citation_validation"])
    if classification.explicit_visual_request or decision.level.value >= 2:
        steps.append("visualization_planning")
    if decision.level.value >= 3:
        steps.append("learning_check_planning")
    steps.append("response_assembly")
    return OrchestrationPlan(classification, decision, tuple(steps))

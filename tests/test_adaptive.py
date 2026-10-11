import pytest

from packages.shared.adaptive import (
    FrictionSignals,
    RepresentationLevel,
    adaptive_decision,
    choose_representation,
    score_learning_friction,
)


def test_explicit_confusion_and_failed_checks_raise_learning_friction():
    score, reasons = score_learning_friction(
        FrictionSignals(
            explicit_confusion=True,
            repeated_concept_questions=3,
            failed_checkpoints=2,
            confidence=0.2,
        )
    )
    assert score > 0.65
    assert "EXPLICIT_CONFUSION" in reasons
    decision = adaptive_decision(
        FrictionSignals(
            explicit_confusion=True,
            failed_checkpoints=2,
            repeated_concept_questions=2,
        )
    )
    assert decision.level >= RepresentationLevel.VISUAL_INTERVENTION


def test_policy_cooldown_and_hysteresis_prevent_chattering():
    assert (
        choose_representation(
            0.1,
            previous_level=RepresentationLevel.VISUAL_INTERVENTION,
            turns_since_change=0,
        )
        == RepresentationLevel.VISUAL_INTERVENTION
    )
    assert (
        choose_representation(
            0.4,
            previous_level=RepresentationLevel.VISUAL_INTERVENTION,
            turns_since_change=3,
        )
        == RepresentationLevel.VISUAL_INTERVENTION
    )
    assert (
        choose_representation(
            0.3,
            previous_level=RepresentationLevel.VISUAL_INTERVENTION,
            turns_since_change=3,
        )
        == RepresentationLevel.OFFER_VISUAL
    )


def test_policy_rejects_invalid_threshold_order():
    with pytest.raises(ValueError, match="thresholds"):
        choose_representation(0.3, low_threshold=0.5, medium_threshold=0.4, high_threshold=0.7)

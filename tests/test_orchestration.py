from packages.shared.orchestration import classify_request, plan_request
from services.api.eas_api.config import Settings


def test_classifier_routes_simple_vs_confused_or_visual_questions():
    simple = classify_request("Where is the definition in my notes?")
    confused = classify_request("I don't understand why the graph changes")
    assert not simple.conceptual
    assert confused.conceptual and confused.explicit_confusion

    plan = plan_request("Show me a diagram of the process", Settings())
    assert plan.classification.explicit_visual_request
    assert "visualization_planning" in plan.steps


def test_repeated_questions_raise_friction_and_add_learning_path():
    plan = plan_request(
        "Explain why the process works",
        Settings(),
        repeated_concept_questions=3,
        failed_checkpoints=2,
    )
    assert plan.decision.score >= 0.4
    assert "learning_need" in plan.steps

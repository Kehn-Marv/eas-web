from eas.services.session.turns.resource_reuse import apply_resource_reuse


def test_one_turn_choices_are_used_without_persisting():
    payload = {
        "knowledge_bases": ["book", "agent"],
        "persona": "tutor",
        "skills": ["math"],
    }
    preferences = dict(payload)
    apply_resource_reuse(
        preferences, {"persona": False, "skills": False}, ["agent", "unselected"]
    )
    assert preferences == {"knowledge_bases": ["agent"], "persona": "", "skills": []}
    assert payload["knowledge_bases"] == ["book", "agent"]
    assert payload["skills"] == ["math"]


def test_legacy_and_repeated_choices_stay_unchanged():
    for reuse in (None, {}, {"persona": True, "skills": True}):
        preferences = {
            "knowledge_bases": ["book"],
            "persona": "tutor",
            "skills": ["math"],
        }
        expected = dict(preferences)
        apply_resource_reuse(preferences, reuse, None)
        assert preferences == expected

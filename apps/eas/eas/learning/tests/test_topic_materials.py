"""A topic's materials must reach the tutor, and be honest when they cannot."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from eas.learning.models import TopicSource, TopicSourceKind
from eas.learning.topic_materials import (
    build_topic_materials,
    render_topic_manifest,
)


def _source(kind: TopicSourceKind, source_id: str, label: str, **kwargs) -> TopicSource:
    return TopicSource(
        id=f"source_{source_id or label}",
        kind=kind,
        source_id=source_id,
        label=label,
        **kwargs,
    )


def test_goal_source_is_not_offered_as_readable_material() -> None:
    """The goal is the objective, not something to 'read'."""
    materials = build_topic_materials(
        [_source(TopicSourceKind.GOAL, "", "Learning goal", excerpt="Master RAG")]
    )
    assert materials.is_empty()
    assert render_topic_manifest(materials) == ("", {})


def test_knowledge_base_is_listed_as_searchable_but_never_readable() -> None:
    """A KB is searched with rag; listing it stops the tutor inventing it."""
    materials = build_topic_materials(
        [_source(TopicSourceKind.KNOWLEDGE_BASE, "mechanics-kb", "Mechanics KB")]
    )
    manifest, index = render_topic_manifest(materials)

    assert index == {}
    assert "search with rag" in manifest
    assert "mechanics-kb" in manifest


def test_unavailable_material_is_named_rather_than_dropped() -> None:
    """Silently dropping it is what let the tutor claim it had read the source."""
    materials = build_topic_materials(
        [_source(TopicSourceKind.NOTEBOOK, "nb_gone", "Missing notebook", available=False)]
    )
    manifest, index = render_topic_manifest(materials)

    assert index == {}
    assert "unavailable" in manifest
    assert "Missing notebook" in manifest
    assert "Never describe or quote their contents" in manifest


def test_one_failing_material_never_takes_the_turn_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Losing a material degrades the lesson; raising would end the turn."""

    def _explode() -> None:
        raise RuntimeError("notebook store is down")

    monkeypatch.setattr("eas.services.notebook.get_notebook_manager", _explode)

    async def _fake_load(store, session_id, **kwargs):
        return "User: Hello\nAssistant: Hi", "Healthy Chat"

    monkeypatch.setattr(
        "eas.services.session.source_inventory._load_history_session", _fake_load
    )
    monkeypatch.setattr(
        "eas.learning.topic_materials._session_store", lambda: SimpleNamespace()
    )

    materials = build_topic_materials(
        [
            _source(TopicSourceKind.NOTEBOOK, "nb_1", "Broken notebook", position=0),
            _source(TopicSourceKind.CHAT, "sess_1", "Healthy Chat", position=1),
        ]
    )
    manifest, index = render_topic_manifest(materials)

    assert materials.warnings == ["notebook:nb_1"]
    assert "tc-sess_1" in index
    assert "could not be loaded" in manifest


def test_notebook_becomes_one_source_carrying_its_records(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    records = [
        {"id": "r1", "title": "Multi-hop failure", "output": "Linear RAG cannot chain."},
        {"id": "r2", "title": "Agent OS", "output": "Planning, memory, tools."},
    ]
    monkeypatch.setattr(
        "eas.services.notebook.get_notebook_manager",
        lambda: SimpleNamespace(get_records_by_references=lambda refs: records),
    )
    materials = build_topic_materials([_source(TopicSourceKind.NOTEBOOK, "nb_1", "Study log")])
    manifest, index = render_topic_manifest(materials)

    assert list(index) == ["nb-topic-nb_1"]
    assert "Linear RAG cannot chain." in index["nb-topic-nb_1"]
    assert "Planning, memory, tools." in index["nb-topic-nb_1"]
    assert "Study log (2 records)" in manifest


def test_a_hand_picked_knowledge_base_file_is_searchable_not_a_dead_end():
    """Picking one document out of a library used to produce a material the
    tutor was told it could never read — so the careful selection was silently
    worse than selecting the whole base."""
    materials = build_topic_materials(
        [
            _source(
                TopicSourceKind.FILE,
                "papers/attention.pdf",
                "attention.pdf",
                metadata={"kb_name": "ml-papers"},
            )
        ]
    )
    row = materials.materials[0]
    assert row.available is True
    assert "ml-papers" in row.note
    assert "search with rag" in row.note

    manifest, index = render_topic_manifest(materials)
    file_row = next(line for line in manifest.splitlines() if "attention.pdf" in line)
    assert "unavailable" not in file_row
    assert index == {}


def test_a_chat_transcript_becomes_readable_material(monkeypatch: pytest.MonkeyPatch):
    """Reuses chat's own reader, so a conversation attached to a goal reads
    exactly like one attached to a chat turn."""

    async def _fake_load(store, session_id, **kwargs):
        assert session_id == "sess_42"
        return "User: What is an eigenvalue?\nAssistant: A scalar factor by which a vector is scaled...", "Linear Algebra Q&A"

    monkeypatch.setattr(
        "eas.services.session.source_inventory._load_history_session", _fake_load
    )
    monkeypatch.setattr(
        "eas.learning.topic_materials._session_store", lambda: SimpleNamespace()
    )

    materials = build_topic_materials([_source(TopicSourceKind.CHAT, "sess_42", "Past Conversation")])
    row = materials.materials[0]
    assert row.readable is True
    assert row.name == "Linear Algebra Q&A"
    assert "eigenvalue" in row.full_text
    assert row.sid.startswith("tc-")
    assert render_topic_manifest(materials)[1] == {row.sid: row.full_text}


def test_a_question_bank_entry_becomes_readable_material(monkeypatch: pytest.MonkeyPatch):
    async def _fake_entry(store, entry_id):
        assert entry_id == 7
        return "**Q:** 2+2?\n**Their answer:** 5 (wrong)", "2+2?"

    monkeypatch.setattr(
        "eas.services.session.source_inventory._load_question_entry", _fake_entry
    )
    monkeypatch.setattr(
        "eas.learning.topic_materials._session_store", lambda: SimpleNamespace()
    )

    materials = build_topic_materials([_source(TopicSourceKind.QUESTION_BANK, "7", "A Wrong Answer")])
    row = materials.materials[0]
    assert row.readable is True
    assert row.sid == "tq-7"
    assert "wrong" in row.full_text


def test_a_malformed_question_bank_reference_says_so_instead_of_raising():
    materials = build_topic_materials(
        [_source(TopicSourceKind.QUESTION_BANK, "not-a-number", "Bad Reference")]
    )
    row = materials.materials[0]
    assert row.available is False
    assert "valid entry id" in row.note

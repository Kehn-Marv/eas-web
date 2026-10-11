import asyncio
import json
from uuid import UUID

import pymupdf
from fastapi.testclient import TestClient

from packages.shared.db import make_session_factory
from packages.shared.models import Document, DocumentAsset, DocumentStatus
from services.api.eas_api import main as api_main
from services.api.eas_api import turns as turns_api
from services.api.eas_api.config import Settings
from services.api.eas_api.main import app
from services.worker.eas_worker.runner import Worker


def test_upload_is_private_scoped_and_idempotent(tmp_path, monkeypatch):
    monkeypatch.setenv("STORAGE_ROOT", str(tmp_path / "objects"))
    with TestClient(app) as client:
        session_response = client.post("/v1/sessions")
        assert session_response.status_code == 201
        assert "eas_session" in session_response.cookies
        session_id = session_response.json()["session_id"]
        assert client.get(f"/v1/sessions/{session_id}").status_code == 200

        body = b"%PDF-1.7\nfixture"
        uploaded = client.post(
            "/v1/documents", files={"file": ("../lesson.pdf", body, "application/pdf")}
        )
        assert uploaded.status_code == 202, uploaded.text
        record = uploaded.json()
        assert record["filename"] == "lesson.pdf"
        assert record["status"] == "VALIDATING"
        queued_job = client.get(f"/v1/jobs/{record['job_id']}").json()
        assert queued_job["status"] == "queued"
        assert [event["type"] for event in queued_job["events"]] == ["queued"]

        duplicate = client.post(
            "/v1/documents", files={"file": ("lesson-copy.pdf", body, "application/pdf")}
        )
        assert duplicate.status_code == 202, duplicate.text
        assert duplicate.json()["document_id"] == record["document_id"]
        assert duplicate.json()["duplicate"] is True

        assert client.get(f"/v1/documents/{record['document_id']}").status_code == 200
        assert client.get(f"/v1/documents/{record['document_id']}/status").status_code == 200
        assert client.delete(f"/v1/documents/{record['document_id']}").status_code == 204
        assert client.get(f"/v1/documents/{record['document_id']}").status_code == 404


def test_upload_requires_session_and_checks_magic_bytes():
    with TestClient(app) as client:
        no_session = client.post(
            "/v1/documents", files={"file": ("fake.pdf", b"not a pdf", "application/pdf")}
        )
        assert no_session.status_code == 401
        client.post("/v1/sessions")
        invalid = client.post(
            "/v1/documents", files={"file": ("fake.pdf", b"not a pdf", "application/pdf")}
        )
        assert invalid.status_code == 415


def test_source_assets_are_retrievable_only_by_their_owning_session(monkeypatch, tmp_path):
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{(tmp_path / 'assets.db').as_posix()}",
        storage_root=str(tmp_path / "objects"),
    )
    monkeypatch.setattr(api_main, "get_settings", lambda: settings)
    source = tmp_path / "source.png"
    source.write_bytes(b"private-image-bytes")

    with TestClient(app) as client:
        owner_session = client.post("/v1/sessions").json()["session_id"]
        factory = make_session_factory(client.app.state.db_engine)

        async def seed_asset():
            async with factory() as db:
                document = Document(
                    session_id=UUID(owner_session),
                    filename="source.pdf",
                    media_type="application/pdf",
                    content_hash="a" * 64,
                    object_key="documents/test/original.pdf",
                    byte_size=1,
                    status=DocumentStatus.READY,
                    completeness_status="complete",
                    index_status="ready",
                )
                db.add(document)
                await db.flush()
                asset = DocumentAsset(
                    document_id=document.id,
                    page_number=1,
                    asset_type="image",
                    object_key="documents/test/figure.png",
                    media_type="image/png",
                    content_hash="b" * 64,
                    byte_size=source.stat().st_size,
                )
                db.add(asset)
                await client.app.state.storage.put_file(
                    asset.object_key, source, "image/png"
                )
                await db.commit()
                return document.id, asset.id

        document_id, asset_id = asyncio.run(seed_asset())
        fetched = client.get(f"/v1/documents/{document_id}/assets/{asset_id}")
        assert fetched.status_code == 200
        assert fetched.content == b"private-image-bytes"
        assert fetched.headers["cache-control"] == "private, no-store"

        client.post("/v1/sessions")
        forbidden = client.get(f"/v1/documents/{document_id}/assets/{asset_id}")
        assert forbidden.status_code == 404


def test_worker_completes_upload_and_page_reprocess_endpoint(monkeypatch, tmp_path):
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{(tmp_path / 'documents.db').as_posix()}",
        storage_root=str(tmp_path / "objects"),
        adaptive_low_threshold=0.1,
        adaptive_medium_threshold=0.2,
        adaptive_high_threshold=0.3,
    )
    monkeypatch.setattr(
        api_main,
        "get_settings",
        lambda: settings,
    )
    pdf = pymupdf.open()
    page = pdf.new_page()
    page.insert_text(
        (72, 72),
        "This page contains enough normal text for extraction and completeness validation.",
    )
    content = pdf.tobytes()
    pdf.close()

    with TestClient(app) as client:
        client.post("/v1/sessions")
        uploaded = client.post(
            "/v1/documents", files={"file": ("worker.pdf", content, "application/pdf")}
        )
        assert uploaded.status_code == 202
        document_id = uploaded.json()["document_id"]
        asyncio.run(_run_worker_once(client.app.state.settings))
        asyncio.run(_run_worker_once(client.app.state.settings))
        report = client.get(f"/v1/documents/{document_id}/status").json()
        assert report["status"] == "READY"
        assert report["index_status"] == "ready"
        search = client.post(
            f"/v1/sessions/{client.cookies['eas_session']}/search",
            json={"query": "normal text extraction", "document_ids": [document_id]},
        )
        assert search.status_code == 200
        assert search.json()["hits"][0]["retrieval_method"] == "lexical"
        assert search.json()["context_sources"][0]["page_number"] == 1
        block_id = search.json()["hits"][0]["block_id"]
        session_id = client.cookies["eas_session"]
        turn_response = client.post(
            f"/v1/sessions/{session_id}/turns",
            headers={"Idempotency-Key": "question-1"},
            json={
                "query": "What does this page say about normal text?",
                "document_ids": [document_id],
            },
        )
        assert turn_response.status_code == 200
        assert turn_response.headers["content-type"].startswith("text/event-stream")
        lines = turn_response.text.splitlines()
        final_index = lines.index("event: final")
        turn = json.loads(lines[final_index + 1].removeprefix("data: "))
        assert turn["citations"][0]["block_id"] == block_id
        assert turn["warnings"] == ["GENERATION_PROVIDER_NOT_CONFIGURED"]
        retried_turn = client.post(
            f"/v1/sessions/{session_id}/turns",
            headers={"Idempotency-Key": "question-1"},
            json={
                "query": "What does this page say about normal text?",
                "document_ids": [document_id],
            },
        )
        retry_lines = retried_turn.text.splitlines()
        retry_final = json.loads(
            retry_lines[retry_lines.index("event: final") + 1].removeprefix("data: ")
        )
        assert retry_final["turn_id"] == turn["turn_id"]
        resume = client.post(
            f"/v1/sessions/{session_id}/turns",
            headers={"Idempotency-Key": "question-1", "Last-Event-ID": "8"},
            json={
                "query": "What does this page say about normal text?",
                "document_ids": [document_id],
            },
        )
        resumed_deltas = "".join(
            json.loads(frame.split("data: ", 1)[1])["text"]
            for frame in resume.text.split("\n\n")
            if frame.startswith("id: ") and "\nevent: delta\n" in frame
        )
        assert resumed_deltas == turn["text"][8:]
        assert (
            client.get(f"/v1/sessions/{session_id}/turns").json()[0]["turn_id"] == turn["turn_id"]
        )

        class FakeLLM:
            histories = []

            async def generate(self, query, sources, conversation_history=None, on_text_delta=None):
                self.histories.append(conversation_history or [])
                answer = f"Follow-up explanation: {query}"
                if on_text_delta:
                    await on_text_delta(answer)
                return json.dumps(
                    {"text": answer, "citation_chunk_ids": [sources[0]["chunk_id"]]}
                )

        fake_llm = FakeLLM()
        client.app.state.llm_provider = fake_llm
        monkeypatch.setattr(turns_api, "llm_enabled", lambda _settings: True)
        follow_up = client.post(
            f"/v1/sessions/{session_id}/turns",
            headers={"Idempotency-Key": "question-follow-up"},
            json={
                "query": "Can you explain normal text extraction further?",
                "document_ids": [document_id],
            },
        )
        follow_frames = follow_up.text.split("\n\n")
        follow_final = next(frame for frame in follow_frames if "event: final" in frame)
        follow_delta = next(frame for frame in follow_frames if "event: delta" in frame)
        follow_result = json.loads(follow_final.split("data: ", 1)[1])
        assert follow_frames.index(follow_delta) < follow_frames.index(follow_final)
        assert follow_result["text"] == (
            "Follow-up explanation: Can you explain normal text extraction further?"
        )
        assert fake_llm.histories[0][0]["query"] == "What does this page say about normal text?"
        assert fake_llm.histories[0][0]["response"] == turn["text"]

        interactive = client.post(
            f"/v1/sessions/{session_id}/turns",
            headers={"Idempotency-Key": "visual-turn-1"},
            json={
                "query": "I don't understand the process of normal text extraction",
                "document_ids": [document_id],
                "mode": "INTERACTIVE",
            },
        )
        interactive_lines = interactive.text.splitlines()
        interactive_final = json.loads(
            interactive_lines[interactive_lines.index("event: final") + 1].removeprefix("data: ")
        )
        assert interactive_final["mode"] == "INTERACTIVE"
        assert client.get(f"/v1/sessions/{session_id}").json()["learning_mode"] == "INTERACTIVE"
        assert len(interactive_final["visualizations"]) == 1
        assert len(interactive_final["checks"]) == 1
        auto_check = interactive_final["checks"][0]
        assert "_____" in auto_check["question"]
        assert "expected_answer" not in auto_check
        auto_answer = client.post(
            f"/v1/sessions/{session_id}/checks/{auto_check['check_id']}/answer",
            json={"answer": "completeness", "confidence": 0.9},
        )
        assert auto_answer.status_code == 200
        assert auto_answer.json()["correctness"] is True
        visualization_id = interactive_final["visualization_ids"][0]
        visualization = client.get(f"/v1/visualizations/{visualization_id}")
        assert visualization.status_code == 200
        spec = visualization.json()["spec"]
        assert spec["source_refs"][0]["document_id"] == document_id
        interaction_id = spec["interactions"][0]["id"]
        interaction = client.post(
            f"/v1/visualizations/{visualization_id}/interact",
            headers={"Idempotency-Key": "select-source-1"},
            json={"interaction_id": interaction_id},
        )
        assert interaction.status_code == 201
        replay = client.post(
            f"/v1/visualizations/{visualization_id}/interact",
            headers={"Idempotency-Key": "select-source-1"},
            json={"interaction_id": interaction_id},
        )
        assert replay.json()["event_id"] == interaction.json()["event_id"]
        assert client.get(f"/v1/sessions/{session_id}/turns").json()[0]["visualization_ids"] == [
            visualization_id
        ]
        assert report["expected_page_count"] == 1
        page_response = client.get(f"/v1/documents/{document_id}/pages/1")
        assert page_response.status_code == 200
        assert page_response.json()["status"] == "READY"
        assert page_response.json()["blocks"][0]["source_type"] == "paragraph"
        block_id = page_response.json()["blocks"][0]["block_id"]
        session_id = client.cookies["eas_session"]
        check = client.post(
            f"/v1/sessions/{session_id}/checks",
            headers={"Idempotency-Key": "gravity-check-1"},
            json={
                "concept_id": "gravity",
                "check_type": "multiple_choice",
                "question": "What causes this effect?",
                "options": ["A", "B"],
                "expected_answer": "A",
                "source_refs": [
                    {
                        "document_id": document_id,
                        "page_number": 1,
                        "block_id": block_id,
                    }
                ],
            },
        )
        assert check.status_code == 201
        assert "expected_answer" not in check.json()
        answered = client.post(
            f"/v1/sessions/{session_id}/checks/{check.json()['check_id']}/answer",
            json={"answer": "B", "confidence": 0.3, "time_to_answer_seconds": 8},
        )
        assert answered.status_code == 200
        assert answered.json()["correctness"] is False
        learning_state = client.get(f"/v1/sessions/{session_id}/learning-state/gravity")
        assert learning_state.status_code == 200
        assert learning_state.json()["incorrect_count"] == 1

        reprocess = client.post(
            f"/v1/documents/{document_id}/pages/1/reprocess",
            headers={"Idempotency-Key": "redo-page-one"},
        )
        assert reprocess.status_code == 202
        asyncio.run(_run_worker_once(client.app.state.settings))
        assert client.get(f"/v1/documents/{document_id}/pages/1").json()["status"] == "READY"


def test_direct_chat_without_documents_uses_general_answers(monkeypatch, tmp_path):
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{(tmp_path / 'direct-chat.db').as_posix()}",
        storage_root=str(tmp_path / "objects"),
        llm_api_url="https://llm.example/v1/chat/completions",
        llm_api_key="test-secret",
    )
    monkeypatch.setattr(api_main, "get_settings", lambda: settings)

    class FakeLLM:
        histories = []

        async def generate(self, query, sources, conversation_history=None, on_text_delta=None):
            assert sources == []
            self.histories.append(conversation_history or [])
            answer = "A prime number has exactly two positive divisors."
            if on_text_delta:
                await on_text_delta(answer)
            return json.dumps({"text": answer, "citation_chunk_ids": []})

    with TestClient(app) as client:
        session_id = client.post("/v1/sessions").json()["session_id"]
        fake_llm = FakeLLM()
        client.app.state.llm_provider = fake_llm
        monkeypatch.setattr(turns_api, "llm_enabled", lambda _settings: True)
        response = client.post(
            f"/v1/sessions/{session_id}/turns",
            headers={"Idempotency-Key": "direct-chat-1"},
            json={"query": "What is a prime number?", "document_ids": []},
        )
        frames = response.text.splitlines()
        turn = json.loads(frames[frames.index("event: final") + 1].removeprefix("data: "))
        assert response.status_code == 200
        assert turn["text"] == "A prime number has exactly two positive divisors."
        assert turn["citations"] == []
        assert turn["warnings"] == ["UNSOURCED_GENERAL_RESPONSE"]

        follow_up = client.post(
            f"/v1/sessions/{session_id}/turns",
            headers={"Idempotency-Key": "direct-chat-2"},
            json={"query": "Can you give an example?", "document_ids": []},
        )
        assert follow_up.status_code == 200
        assert fake_llm.histories[1][0]["query"] == "What is a prime number?"
        assert client.get(f"/v1/sessions/{session_id}/turns?limit=100").status_code == 200


async def _run_worker_once(settings=None):
    worker = Worker(settings=settings)
    try:
        assert await worker.run_once()
    finally:
        await worker.engine.dispose()

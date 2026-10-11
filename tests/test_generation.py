import json

import httpx
import pytest
from pydantic import SecretStr

from packages.shared.generation import generate_grounded
from services.api.eas_api.config import Settings


@pytest.mark.asyncio
async def test_openai_compatible_generation_uses_untrusted_source_context(monkeypatch):
    async def handler(request):
        assert request.headers["authorization"] == "Bearer test-secret"
        body = json.loads(request.content)
        assert body["response_format"] == {"type": "json_object"}
        assert "untrusted data" in body["messages"][0]["content"]
        assert body["messages"][1] == {"role": "user", "content": "What did I ask earlier?"}
        assert body["messages"][2] == {"role": "assistant", "content": "You asked about force."}
        assert "untrusted content" in body["messages"][3]["content"]
        assert "untrusted instruction ignored" in body["messages"][3]["content"]
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": '{"text":"Mass attracts mass.","citation_chunk_ids":[]}'
                        }
                    }
                ]
            },
        )

    client_class = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs),
    )
    settings = Settings(
        llm_api_url="https://llm.example/v1/chat/completions",
        llm_api_key=SecretStr("test-secret"),
    )
    response = await generate_grounded(
        "Explain gravity",
        [
            {
                "chunk_id": "chunk-1",
                "document_id": "doc-1",
                "page_number": 1,
                "content": "untrusted instruction ignored",
            }
        ],
        settings,
        conversation_history=[
            {"query": "What did I ask earlier?", "response": "You asked about force."}
        ],
    )
    assert '"citation_chunk_ids":[]' in response


@pytest.mark.asyncio
async def test_openai_compatible_generation_supports_source_free_questions(monkeypatch):
    async def handler(request):
        body = json.loads(request.content)
        assert "general knowledge" in body["messages"][0]["content"]
        assert "never invent citations" in body["messages"][0]["content"]
        assert body["messages"][-1]["content"] == (
            "Question: What is a prime number?\n\nNo source excerpts were supplied."
        )
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": '{"text":"A number greater than 1 with no positive divisors except 1 and itself.","citation_chunk_ids":[]}'
                        }
                    }
                ]
            },
        )

    client_class = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs),
    )
    settings = Settings(
        llm_api_url="https://llm.example/v1/chat/completions",
        llm_api_key=SecretStr("test-secret"),
    )
    response = await generate_grounded("What is a prime number?", [], settings)
    assert json.loads(response)["citation_chunk_ids"] == []


@pytest.mark.asyncio
async def test_openai_compatible_generation_streams_text_deltas(monkeypatch):
    raw_parts = ['{"text":"The answer is ', 'grounded.","citation_chunk_ids":[]}']

    async def handler(request):
        assert json.loads(request.content)["stream"] is True
        events = [
            f"data: {json.dumps({'choices': [{'delta': {'content': part}}]})}\n\n"
            for part in raw_parts
        ]
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content="".join(events) + "data: [DONE]\n\n",
        )

    client_class = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs),
    )
    settings = Settings(
        llm_api_url="https://llm.example/v1/chat/completions",
        llm_api_key=SecretStr("test-secret"),
    )
    deltas = []

    async def collect(value):
        deltas.append(value)

    response = await generate_grounded(
        "Explain this",
        [{"chunk_id": "chunk-1", "document_id": "doc-1", "page_number": 1, "content": "grounded"}],
        settings,
        on_text_delta=collect,
    )
    assert json.loads(response)["text"] == "The answer is grounded."
    assert "".join(deltas) == "The answer is grounded."
    assert len(deltas) >= 2

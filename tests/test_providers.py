import json

import httpx
import pytest
from pydantic import SecretStr

from packages.shared.vision import OpenAICompatibleVisionProvider
from services.api.eas_api.config import Settings


@pytest.mark.asyncio
async def test_vision_provider_sends_bounded_data_uri_and_parses_response(monkeypatch):
    async def handler(request):
        assert request.headers["authorization"] == "Bearer vision-secret"
        payload = json.loads(request.content)
        image = payload["messages"][0]["content"][1]["image_url"]["url"]
        assert image == "data:image/png;base64,cG5n"
        assert payload["model"] == "vision-model"
        return httpx.Response(
            200, json={"choices": [{"message": {"content": "A labeled chart."}}]}
        )

    client_class = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs),
    )
    settings = Settings(
        vision_api_url="https://vision.example/v1/chat/completions",
        vision_api_key=SecretStr("vision-secret"),
        vision_model="vision-model",
    )
    result = await OpenAICompatibleVisionProvider(settings).describe_image(
        b"png", "image/png", "Describe this figure"
    )
    assert result == "A labeled chart."

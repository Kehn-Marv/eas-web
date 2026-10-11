"""Optional OpenAI-compatible image-description provider, never invoked implicitly."""

from __future__ import annotations

import base64
from typing import Protocol

import httpx

from packages.shared.providers import VisionProvider


class VisionSettings(Protocol):
    vision_api_url: str | None
    vision_api_key: object | None
    vision_model: str
    vision_timeout_seconds: float


class VisionProviderError(RuntimeError):
    pass


class OpenAICompatibleVisionProvider(VisionProvider):
    def __init__(self, settings: VisionSettings):
        self.settings = settings

    async def describe_image(self, image: bytes, media_type: str, prompt: str) -> str:
        if not self.settings.vision_api_url or not self.settings.vision_api_key:
            raise VisionProviderError("Vision provider is not configured")
        if (
            media_type not in {"image/png", "image/jpeg", "image/webp"}
            or len(image) > 10 * 1024 * 1024
        ):
            raise VisionProviderError("Image type or size is unsupported")
        body = {
            "model": self.settings.vision_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt[:2000]},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": (
                                    f"data:{media_type};base64,"
                                    f"{base64.b64encode(image).decode('ascii')}"
                                )
                            },
                        },
                    ],
                }
            ],
        }
        try:
            async with httpx.AsyncClient(timeout=self.settings.vision_timeout_seconds) as client:
                response = await client.post(
                    self.settings.vision_api_url,
                    headers={
                        "Authorization": (
                            f"Bearer {self.settings.vision_api_key.get_secret_value()}"
                        ),
                        "Content-Type": "application/json",
                    },
                    json=body,
                )
                response.raise_for_status()
                result = response.json()
            content = result["choices"][0]["message"]["content"]
            if isinstance(content, list):
                content = " ".join(
                    str(item.get("text", "")) for item in content if isinstance(item, dict)
                )
            if not isinstance(content, str) or not content.strip():
                raise ValueError("Vision response is empty")
            return content[:8000]
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
            raise VisionProviderError(type(exc).__name__) from exc

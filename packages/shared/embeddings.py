"""OpenAI-compatible embeddings API client with strict response validation."""

from typing import Protocol

import httpx

from packages.shared.providers import EmbeddingProvider


class EmbeddingSettings(Protocol):
    embedding_api_url: str | None
    embedding_api_key: object
    embedding_model: str
    embedding_dimensions: int
    embedding_timeout_seconds: float


class EmbeddingProviderError(RuntimeError):
    pass


def embedding_enabled(settings: EmbeddingSettings) -> bool:
    return bool(settings.embedding_api_url and settings.embedding_api_key)


async def embed_texts(texts: list[str], settings: EmbeddingSettings) -> list[list[float]]:
    if not embedding_enabled(settings):
        raise EmbeddingProviderError("Embedding provider is not configured")
    headers = {
        "Authorization": f"Bearer {settings.embedding_api_key.get_secret_value()}",
        "Content-Type": "application/json",
    }
    body = {
        "model": settings.embedding_model,
        "input": texts,
        "dimensions": settings.embedding_dimensions,
    }
    try:
        async with httpx.AsyncClient(timeout=settings.embedding_timeout_seconds) as client:
            response = await client.post(settings.embedding_api_url, headers=headers, json=body)
            response.raise_for_status()
            result = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise EmbeddingProviderError(type(exc).__name__) from exc
    try:
        vectors = [
            entry["embedding"] for entry in sorted(result["data"], key=lambda row: row["index"])
        ]
        if len(vectors) != len(texts):
            raise ValueError("Embedding response count mismatch")
        parsed = [[float(value) for value in vector] for vector in vectors]
        if any(
            len(vector) != settings.embedding_dimensions
            or any(not (-1e6 < value < 1e6) for value in vector)
            for vector in parsed
        ):
            raise ValueError("Embedding dimensions or values are invalid")
        return parsed
    except (KeyError, TypeError, ValueError) as exc:
        raise EmbeddingProviderError(type(exc).__name__) from exc


class OpenAICompatibleEmbeddings(EmbeddingProvider):
    """Configured OpenAI-compatible embedding adapter."""

    def __init__(self, settings: EmbeddingSettings):
        self.settings = settings

    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return await embed_texts(texts, self.settings)

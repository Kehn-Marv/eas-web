"""Small capability contracts for swappable external and document providers."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol


class EmbeddingProvider(Protocol):
    async def embed_texts(self, texts: list[str]) -> list[list[float]]: ...


class VisionProvider(Protocol):
    async def describe_image(self, image: bytes, media_type: str, prompt: str) -> str: ...


class RerankerProvider(Protocol):
    def rerank(
        self,
        query: str,
        candidates: Sequence[tuple[str, str | None, float]],
    ) -> list[tuple[float, int]]: ...


class ParserProvider(Protocol):
    @property
    def page_count(self) -> int: ...

    def parse_page(self, page_number: int) -> object: ...

    def close(self) -> None: ...

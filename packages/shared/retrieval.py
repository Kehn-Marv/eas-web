"""Small deterministic retrieval primitives shared by API and worker."""

import re
from collections import Counter
from collections.abc import Hashable, Sequence

from packages.shared.providers import RerankerProvider

_QUERY_SYNONYMS = {
    "cause": ("reason", "why"),
    "compare": ("difference", "similarity"),
    "define": ("meaning", "definition"),
    "effect": ("result", "consequence"),
    "formula": ("equation",),
    "method": ("steps", "process"),
    "show": ("explain", "illustrate"),
}


def rewrite_query(query: str, *, max_variants: int = 4) -> list[str]:
    """Return a bounded set of transparent lexical query variants."""
    normalized = " ".join(query.casefold().split())
    variants = [normalized]
    tokens = re.findall(r"[\w'-]+", normalized)
    expansions = [word for token in tokens for word in _QUERY_SYNONYMS.get(token, ())]
    for expansion in expansions:
        variant = f"{normalized} {expansion}"
        if variant not in variants:
            variants.append(variant)
        if len(variants) >= max_variants:
            break
    return variants


def rerank_score(
    query: str,
    content: str,
    section_title: str | None,
    fused_score: float,
) -> float:
    """Apply a bounded lexical rerank after sparse/dense rank fusion."""
    normalized_query = " ".join(query.casefold().split())
    normalized_content = " ".join(content.casefold().split())
    phrase_boost = 0.02 if normalized_query and normalized_query in normalized_content else 0.0
    title_score = lexical_score(query, section_title or "")
    content_score = lexical_score(query, content)
    return (
        fused_score
        + min(content_score, 1.0) * 0.01
        + min(title_score, 1.0) * 0.025
        + phrase_boost
    )


class LexicalReranker(RerankerProvider):
    """CPU-only deterministic reranker; deployments can inject a learned provider later."""

    def rerank(
        self,
        query: str,
        candidates: Sequence[tuple[str, str | None, float]],
    ) -> list[tuple[float, int]]:
        ranked = [
            (rerank_score(query, content, section_title, base_score), index)
            for index, (content, section_title, base_score) in enumerate(candidates)
        ]
        return sorted(ranked, key=lambda pair: pair[0], reverse=True)


def lexical_score(query: str, content: str) -> float:
    terms = set(re.findall(r"[\w'-]+", query.casefold()))
    words = Counter(re.findall(r"[\w'-]+", content.casefold()))
    if not terms or not words:
        return 0.0
    counts = {word: words[word] for word in terms}
    matched = sum(count > 0 for count in counts.values())
    if not matched:
        return 0.0
    frequency = sum(min(value, 3) for value in counts.values())
    return (matched / len(terms)) * (1 + frequency / sum(words.values()))


def reciprocal_rank_fusion[T: Hashable](
    *rankings: Sequence[T], k: int = 60
) -> list[tuple[float, T]]:
    scores: dict[T, float] = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking, start=1):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank)
    return sorted(
        ((score, item) for item, score in scores.items()), key=lambda pair: pair[0], reverse=True
    )

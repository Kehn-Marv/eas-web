"""Offline retrieval benchmark metrics with optional EvaluationRecord persistence."""

from __future__ import annotations

import os
from statistics import mean
from typing import Any

from packages.shared.db import make_engine, make_session_factory
from packages.shared.models import EvaluationRecord


def evaluate_case(case: dict[str, Any], *, k: int = 5) -> dict[str, float]:
    relevant_chunks = set(case.get("relevant_chunk_ids", []))
    retrieved = list(case.get("retrieved_chunk_ids", []))
    recall = (
        len(relevant_chunks.intersection(retrieved[:k])) / len(relevant_chunks)
        if relevant_chunks
        else 1.0
    )
    actual_citations = {
        tuple(value) for value in case.get("retrieved_citations", case.get("citations", []))
    }
    gold_citations = {
        tuple(value) for value in case.get("relevant_citations", case.get("relevant_pages", []))
    }
    supported_citations = actual_citations.intersection(gold_citations)
    precision = (
        len(supported_citations) / len(actual_citations)
        if actual_citations
        else (1.0 if not gold_citations else 0.0)
    )
    citation_recall = (
        len(supported_citations) / len(gold_citations) if gold_citations else 1.0
    )
    actual_pages = {
        tuple(value[:2]) for value in actual_citations
    }
    gold_pages = {
        tuple(value[:2]) for value in case.get("relevant_pages", case.get("relevant_citations", []))
    }
    page_accuracy = (
        len(actual_pages.intersection(gold_pages)) / len(actual_pages)
        if actual_pages
        else (1.0 if not gold_pages else 0.0)
    )
    return {
        f"recall@{k}": recall,
        "citation_precision": precision,
        "citation_recall": citation_recall,
        "page_accuracy": page_accuracy,
    }


def evaluate_benchmark(data: dict[str, Any]) -> dict[str, Any]:
    cases = data.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("Benchmark must contain a non-empty cases array")
    k = int(data.get("k", 5))
    if not 1 <= k <= 100:
        raise ValueError("k must be between 1 and 100")
    results = [{"item_id": str(case["id"]), **evaluate_case(case, k=k)} for case in cases]
    metrics = sorted(results[0].keys() - {"item_id"})
    return {
        "evaluation_set": str(data.get("name", "unnamed")),
        "case_count": len(results),
        "metrics": {metric: mean(row[metric] for row in results) for metric in metrics},
        "cases": results,
    }


async def persist(result: dict[str, Any]) -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return
    engine = make_engine(database_url)
    factory = make_session_factory(engine)
    async with factory() as db:
        for case in result["cases"]:
            for metric, value in case.items():
                if metric != "item_id":
                    db.add(EvaluationRecord(
                        evaluation_set=result["evaluation_set"],
                        item_id=case["item_id"],
                        metric=metric,
                        value=value,
                        details={"case_count": result["case_count"]},
                    ))
        await db.commit()
    await engine.dispose()



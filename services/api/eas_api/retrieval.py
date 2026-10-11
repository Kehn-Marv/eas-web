"""Session-scoped lexical retrieval and citation-ready context assembly."""

import hashlib
import math
import os
import unicodedata
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, func, or_, select

from packages.shared.db import make_session_factory
from packages.shared.embeddings import (
    EmbeddingProviderError,
    OpenAICompatibleEmbeddings,
    embedding_enabled,
)
from packages.shared.models import (
    Document,
    DocumentAsset,
    DocumentChunk,
    DocumentEmbedding,
    DocumentPage,
    DocumentSection,
    LearningSession,
    RetrievalEvent,
)
from packages.shared.retrieval import (
    LexicalReranker,
    lexical_score,
    reciprocal_rank_fusion,
    rewrite_query,
)

router = APIRouter(prefix="/v1")


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=2000)
    document_ids: list[UUID] = Field(default_factory=list, max_length=20)
    limit: int = Field(default=8, ge=1, le=20)
    context_budget_tokens: int = Field(default=3000, ge=100, le=12000)


class SourceHit(BaseModel):
    document_id: UUID
    page_number: int
    section_id: UUID | None = None
    block_id: UUID
    chunk_id: UUID
    content: str
    score: float
    retrieval_method: str
    source_location: dict[str, object]


class SearchResponse(BaseModel):
    query: str
    hits: list[SourceHit]
    context: str
    context_sources: list[dict[str, object]]


def normalize_query(query: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", query).casefold().split())


def _merge_chunk_text(existing: str, incoming: str) -> str:
    left = existing.split()
    right = incoming.split()
    maximum = min(len(left), len(right))
    overlap = next(
        (length for length in range(maximum, 0, -1) if left[-length:] == right[:length]),
        0,
    )
    return " ".join(left + right[overlap:])


@router.post("/sessions/{session_id}/search", response_model=SearchResponse)
async def search_session(request: Request, session_id: UUID, body: SearchRequest) -> SearchResponse:
    raw_owner = request.cookies.get("eas_session")
    try:
        owner_id = UUID(raw_owner or "")
    except ValueError as exc:
        raise HTTPException(
            401, detail={"code": "UNAUTHORIZED", "message": "Create a study session first."}
        ) from exc
    if owner_id != session_id:
        raise HTTPException(
            404, detail={"code": "SESSION_NOT_FOUND", "message": "Session not found."}
        )
    query = normalize_query(body.query)
    if not query:
        raise HTTPException(422, detail={"code": "EMPTY_QUERY", "message": "Enter a search query."})
    factory = make_session_factory(request.app.state.db_engine)
    settings = request.app.state.settings
    async with factory() as db:
        if await db.get(LearningSession, session_id) is None:
            raise HTTPException(
                404, detail={"code": "SESSION_NOT_FOUND", "message": "Session not found."}
            )
        documents_query = select(Document.id).where(
            Document.session_id == session_id,
            Document.index_status == "ready",
        )
        if body.document_ids:
            documents_query = documents_query.where(Document.id.in_(body.document_ids))
        allowed_ids = list((await db.scalars(documents_query)).all())
        if not allowed_ids:
            return SearchResponse(query=query, hits=[], context="", context_sources=[])
        sections = list(
            (
                await db.execute(
                    select(DocumentSection.id, DocumentSection.title)
                    .where(DocumentSection.document_id.in_(allowed_ids))
                    .limit(2000)
                )
            ).all()
        )
        section_titles = {section_id: title for section_id, title in sections}
        query_variants = rewrite_query(query)
        matched_sections = sorted(
            (
                (max(lexical_score(variant, title) for variant in query_variants), section_id)
                for section_id, title in sections
                if max(lexical_score(variant, title) for variant in query_variants) > 0
            ),
            reverse=True,
        )[:20]
        chunks = []
        if request.app.state.db_engine.dialect.name == "postgresql":
            search_vector = func.to_tsvector("simple", DocumentChunk.content)
            lexical_rankings = []
            lexical_scores = {}
            for variant in query_variants:
                search_query = func.plainto_tsquery("simple", variant)
                lexical_rank = func.ts_rank(search_vector, search_query)
                lexical_rows = (
                    await db.execute(
                        select(DocumentChunk.id, lexical_rank.label("rank"))
                        .where(
                            DocumentChunk.document_id.in_(allowed_ids),
                            search_vector.op("@@")(search_query),
                        )
                        .order_by(lexical_rank.desc())
                        .limit(100)
                    )
                ).all()
                lexical_rankings.append([row.id for row in lexical_rows])
                lexical_scores.update({row.id: row.rank for row in lexical_rows})
            lexical_ids = [item for _, item in reciprocal_rank_fusion(*lexical_rankings)]
        else:
            chunks = list(
                (
                    await db.scalars(
                        select(DocumentChunk)
                        .where(DocumentChunk.document_id.in_(allowed_ids))
                        .limit(5000)
                    )
                ).all()
            )
            lexical_ranking = sorted(
                (
                    (
                        max(lexical_score(variant, chunk.content) for variant in query_variants),
                        chunk.id,
                    )
                    for chunk in chunks
                    if max(lexical_score(variant, chunk.content) for variant in query_variants) > 0
                ),
                key=lambda pair: pair[0],
                reverse=True,
            )
            lexical_ids = [chunk_id for _, chunk_id in lexical_ranking[:100]]
            lexical_scores = {chunk_id: score for score, chunk_id in lexical_ranking}
        section_chunk_ids: list[UUID] = []
        # Section-title matches form a separate ranking signal without excluding body matches.
        if matched_sections:
            section_chunk_ids = list(
                (
                    await db.scalars(
                        select(DocumentChunk.id)
                        .where(
                            DocumentChunk.document_id.in_(allowed_ids),
                            DocumentChunk.section_id.in_(
                                [section_id for _, section_id in matched_sections]
                            ),
                        )
                        .order_by(DocumentChunk.page_number, DocumentChunk.chunk_index)
                        .limit(100)
                    )
                ).all()
            )
        vector_ids: list[UUID] = []
        vector_scores: dict[UUID, float] = {}
        if embedding_enabled(settings):
            try:
                query_vector = (await OpenAICompatibleEmbeddings(settings).embed_texts([query]))[0]
                pgvector_enabled = (
                    request.app.state.db_engine.dialect.name == "postgresql"
                    and os.getenv("EAS_PGVECTOR_ENABLED", "false").lower()
                    in {"1", "true", "yes"}
                )
                if pgvector_enabled:
                    distance = DocumentEmbedding.embedding.cosine_distance(query_vector)
                    vector_rows = (
                        await db.execute(
                            select(DocumentEmbedding.chunk_id, distance.label("distance"))
                            .where(
                                DocumentEmbedding.document_id.in_(allowed_ids),
                                DocumentEmbedding.model == settings.embedding_model,
                            )
                            .order_by(distance)
                            .limit(100)
                        )
                    ).all()
                    vector_ids = [row.chunk_id for row in vector_rows]
                    vector_scores = {row.chunk_id: 1.0 - row.distance for row in vector_rows}
                else:
                    stored = list(
                        (
                            await db.scalars(
                                select(DocumentEmbedding).where(
                                    DocumentEmbedding.document_id.in_(allowed_ids),
                                    DocumentEmbedding.model == settings.embedding_model,
                                )
                            )
                        ).all()
                    )
                    qnorm = math.sqrt(sum(value * value for value in query_vector))
                    scored = []
                    for embedding in stored:
                        norm = math.sqrt(sum(value * value for value in embedding.embedding))
                        similarity = (
                            sum(
                                a * b
                                for a, b in zip(query_vector, embedding.embedding, strict=True)
                            )
                            / (qnorm * norm)
                            if qnorm and norm
                            else 0.0
                        )
                        scored.append((similarity, embedding.chunk_id))
                    vector_ids = [chunk_id for _, chunk_id in sorted(scored, reverse=True)[:100]]
                    vector_scores = {chunk_id: score for score, chunk_id in scored}
            except EmbeddingProviderError:
                vector_ids = []
        fused = reciprocal_rank_fusion(lexical_ids, vector_ids, section_chunk_ids)[:100]
        fused_ids = [chunk_id for _, chunk_id in fused]
        if request.app.state.db_engine.dialect.name == "postgresql":
            chunk_map = {
                chunk.id: chunk
                for chunk in (
                    await db.scalars(select(DocumentChunk).where(DocumentChunk.id.in_(fused_ids)))
                ).all()
            }
        else:
            chunk_map = {chunk.id: chunk for chunk in chunks}
        ranked = []
        for score, chunk_id in fused:
            chunk = chunk_map.get(chunk_id)
            if chunk is not None:
                method = (
                    "hybrid"
                    if chunk_id in lexical_ids and chunk_id in vector_ids
                    else "vector"
                    if chunk_id in vector_ids
                    else "lexical"
                )
                base_score = (
                    score
                    + lexical_scores.get(chunk.id, 0.0) * 0.001
                    + vector_scores.get(chunk.id, 0.0) * 0.001
                )
                ranked.append((base_score, chunk, method))
        reranked = LexicalReranker().rerank(
            query,
            [
                (chunk.content, section_titles.get(chunk.section_id), score)
                for score, chunk, _method in ranked
            ],
        )
        hits = [
            SourceHit(
                document_id=chunk.document_id,
                page_number=chunk.page_number,
                section_id=chunk.section_id,
                block_id=chunk.block_id,
                chunk_id=chunk.id,
                content=chunk.content,
                score=score,
                retrieval_method=method,
                source_location={"page_number": chunk.page_number, "bbox": chunk.bbox},
            )
            for score, index in reranked[: body.limit]
            for _base, chunk, method in [ranked[index]]
        ]

        sources: list[dict[str, object]] = []
        context_blocks: dict[tuple[UUID, UUID], dict[str, object]] = {}
        consumed = 0
        for hit in hits:
            key = (hit.document_id, hit.block_id)
            existing = context_blocks.get(key)
            merged = (
                _merge_chunk_text(str(existing["content"]), hit.content)
                if existing
                else hit.content
            )
            old_cost = len(str(existing["content"]).split()) if existing else 0
            cost = len(merged.split()) - old_cost
            if consumed + cost > body.context_budget_tokens:
                continue
            consumed += cost
            if existing:
                existing["content"] = merged
                existing["chunk_ids"].append(str(hit.chunk_id))
            else:
                source = {
                    "document_id": str(hit.document_id),
                    "page_number": hit.page_number,
                    "section_id": str(hit.section_id) if hit.section_id else None,
                    "section_title": section_titles.get(hit.section_id),
                    "block_id": str(hit.block_id),
                    "chunk_ids": [str(hit.chunk_id)],
                    "bbox": hit.source_location.get("bbox"),
                }
                sources.append(source)
                context_blocks[key] = {**source, "content": merged}

        # Add adjacent pages only when they also match the query, preserving continuity without
        # flooding context with unrelated page text.
        selected_pages = {(hit.document_id, hit.page_number) for hit in hits}
        neighboring_pages: set[tuple[UUID, int]] = set()
        for hit in hits[:3]:
            for page_number in (hit.page_number - 1, hit.page_number + 1):
                page_key = (hit.document_id, page_number)
                if page_number < 1 or page_key in selected_pages or page_key in neighboring_pages:
                    continue
                page = await db.scalar(
                    select(DocumentPage).where(
                        DocumentPage.document_id == hit.document_id,
                        DocumentPage.page_number == page_number,
                    )
                )
                if (
                    page is None
                    or lexical_score(query, page.extracted_text) <= 0
                    or consumed >= body.context_budget_tokens
                ):
                    continue
                neighboring_pages.add((hit.document_id, page_number))
                remaining = body.context_budget_tokens - consumed
                page_words = page.extracted_text.split()
                selected_words = page_words[:remaining]
                if not selected_words:
                    continue
                text = " ".join(selected_words)
                context_blocks[(hit.document_id, uuid4())] = {
                    "content": text,
                    "document_id": str(hit.document_id),
                    "page_number": page_number,
                    "block_id": None,
                }
                sources.append(
                    {
                        "document_id": str(hit.document_id),
                        "page_number": page_number,
                        "block_id": None,
                        "page_context": True,
                        "truncated": len(selected_words) < len(page_words),
                    }
                )
                consumed += len(selected_words)

        page_scope = {(hit.document_id, hit.page_number) for hit in hits}
        page_scope.update(neighboring_pages)
        asset_scope = [
            and_(DocumentAsset.document_id == document_id, DocumentAsset.page_number == page)
            for document_id, page in page_scope
        ]
        assets = (
            list((await db.scalars(select(DocumentAsset).where(or_(*asset_scope)))).all())
            if asset_scope
            else []
        )
        asset_lines = []
        for asset in assets:
            sources.append(
                {
                    "document_id": str(asset.document_id),
                    "page_number": asset.page_number,
                    "section_id": str(asset.section_id) if asset.section_id else None,
                    "section_title": section_titles.get(asset.section_id),
                    "asset_id": str(asset.id),
                    "asset_type": asset.asset_type,
                    "media_type": asset.media_type,
                    "content_hash": asset.content_hash,
                }
            )
            asset_lines.append(
                f"[source figure asset={asset.id} document={asset.document_id} "
                f"page={asset.page_number} section={section_titles.get(asset.section_id)}]"
            )
        context_parts = [
            f"[document={source['document_id']} page={source['page_number']} "
            f"section={source.get('section_title')} block={source.get('block_id')}]\n"
            f"{source['content']}"
            for source in context_blocks.values()
        ]
        context_parts.extend(asset_lines)
        db.add(
            RetrievalEvent(
                session_id=session_id,
                query_hash=hashlib.sha256(query.encode("utf-8")).hexdigest(),
                result_ids=[str(hit.chunk_id) for hit in hits],
            )
        )
        await db.commit()
        return SearchResponse(
            query=query,
            hits=hits,
            context="\n\n".join(context_parts),
            context_sources=sources,
        )

"""Deterministic, resumable chunk construction for source-grounded retrieval."""

import hashlib
import json
import re
import time
from datetime import UTC, datetime
from uuid import UUID, uuid4, uuid5

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncEngine

from packages.shared.db import make_session_factory
from packages.shared.embeddings import (
    EmbeddingProviderError,
    OpenAICompatibleEmbeddings,
    embedding_enabled,
)
from packages.shared.models import (
    Document,
    DocumentAsset,
    DocumentBlock,
    DocumentChunk,
    DocumentEmbedding,
    DocumentSection,
    DocumentStatus,
    DocumentTreeNode,
    ProviderRequest,
)
from services.api.eas_api.config import Settings, get_settings

CHUNK_WORDS = 220
OVERLAP_WORDS = 35
_NUMBERED_HEADING = re.compile(
    r"^(?:(?:chapter|section)\s+)?(?P<number>\d+(?:\.\d+)*)(?:[.)])?\s+(?P<title>\S.{0,450})$",
    re.IGNORECASE,
)
_NAMED_HEADING = re.compile(r"^(?:chapter|section)\s+\d+\s*[:.-]\s*(?P<title>\S.{0,450})$", re.I)


def _heading(text: str, source_type: str) -> tuple[str, int, float] | None:
    value = " ".join(text.split()).strip()
    if source_type not in {"paragraph", "heading", "title", "ocr"} or "\n" in text:
        return None
    numbered = _NUMBERED_HEADING.match(value)
    if numbered:
        return numbered.group("title").strip(), numbered.group("number").count(".") + 1, 0.95
    named = _NAMED_HEADING.match(value)
    if named:
        return named.group("title").strip(), 1, 0.9
    letters = [char for char in value if char.isalpha()]
    if (
        3 <= len(letters)
        and len(value) <= 120
        and not value.endswith((".", ",", ";", ":"))
        and sum(char.isupper() for char in letters) / len(letters) >= 0.9
    ):
        return value, 1, 0.85
    return None


def _section_id(document_id: UUID, ordinal: int, page_number: int, title: str) -> UUID:
    return uuid5(document_id, f"section:{ordinal}:{page_number}:{title.casefold()}")


def split_text(text: str, size: int = CHUNK_WORDS, overlap: int = OVERLAP_WORDS) -> list[str]:
    words = text.split()
    if not words:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(words):
        end = min(start + size, len(words))
        chunks.append(" ".join(words[start:end]))
        if end == len(words):
            break
        start = end - min(overlap, size - 1)
    return chunks


async def index_document(
    payload: dict[str, object], engine: AsyncEngine, settings: Settings | None = None
) -> None:
    try:
        document_id = UUID(str(payload["document_id"]))
    except (KeyError, ValueError) as exc:
        raise ValueError("Invalid document index payload") from exc
    factory = make_session_factory(engine)
    settings = settings or get_settings()
    async with factory() as db:
        document = await db.get(Document, document_id)
        if document is None:
            return
        document.status = DocumentStatus.BUILDING_INDEX
        document.index_status = "building"
        await db.execute(
            delete(DocumentTreeNode).where(DocumentTreeNode.document_id == document_id)
        )
        await db.execute(
            delete(DocumentEmbedding).where(DocumentEmbedding.document_id == document_id)
        )
        await db.execute(delete(DocumentChunk).where(DocumentChunk.document_id == document_id))
        await db.execute(
            delete(DocumentSection).where(DocumentSection.document_id == document_id)
        )
        await db.commit()

    count = 0
    async with factory() as db:
        blocks = list(
            (
                await db.scalars(
                    select(DocumentBlock)
                    .where(DocumentBlock.document_id == document_id)
                    .order_by(DocumentBlock.page_number, DocumentBlock.block_index)
                )
            ).all()
        )
        assets = list(
            (
                await db.scalars(
                    select(DocumentAsset)
                    .where(DocumentAsset.document_id == document_id)
                    .order_by(DocumentAsset.page_number, DocumentAsset.id)
                )
            ).all()
        )
        section_by_block: dict[UUID, UUID] = {}
        sections: list[DocumentSection] = []
        section_nodes: list[DocumentTreeNode] = []
        section_stack: list[DocumentSection] = []
        current_section: DocumentSection | None = None
        ordinal = 0
        for block in blocks:
            detected = _heading(block.text, block.source_type)
            if detected:
                title, level, confidence = detected
                ordinal += 1
                level = min(level, 8)
                while section_stack and section_stack[-1].level >= level:
                    section_stack.pop()
                parent_section = section_stack[-1] if section_stack else None
                section = DocumentSection(
                    id=_section_id(document_id, ordinal, block.page_number, title),
                    document_id=document_id,
                    parent_id=parent_section.id if parent_section else None,
                    section_key=f"section-{ordinal}",
                    title=title,
                    level=level,
                    ordinal=ordinal,
                    start_page=block.page_number,
                    end_page=block.page_number,
                    detection_method="heuristic",
                    confidence=confidence,
                )
                sections.append(section)
                section_stack.append(section)
                current_section = section
                section_nodes.append(
                    DocumentTreeNode(
                        id=uuid5(document_id, f"tree:section:{section.id}"),
                        document_id=document_id,
                        parent_id=None,
                        node_key=f"section:{section.id}",
                        node_type="section",
                        label=title[:500],
                        sort_order=ordinal,
                        page_number=block.page_number,
                        section_id=section.id,
                        content_hash=block.content_hash,
                    )
                )
                section_by_block[block.id] = section.id
                continue
            if current_section is None:
                ordinal += 1
                current_section = DocumentSection(
                    id=_section_id(document_id, ordinal, block.page_number, "Unsectioned content"),
                    document_id=document_id,
                    parent_id=None,
                    section_key=f"section-{ordinal}",
                    title="Unsectioned content",
                    level=1,
                    ordinal=ordinal,
                    start_page=block.page_number,
                    end_page=block.page_number,
                    detection_method="fallback",
                    confidence=1.0,
                )
                sections.append(current_section)
                section_nodes.append(
                    DocumentTreeNode(
                        id=uuid5(document_id, f"tree:section:{current_section.id}"),
                        document_id=document_id,
                        parent_id=None,
                        node_key=f"section:{current_section.id}",
                        node_type="section",
                        label=current_section.title,
                        sort_order=ordinal,
                        page_number=block.page_number,
                        section_id=current_section.id,
                    )
                )
            current_section.end_page = max(current_section.end_page, block.page_number)
            section_by_block[block.id] = current_section.id

        for block in blocks:
            block.section_id = section_by_block.get(block.id)

        # Figure crops have page-level provenance but no bounding boxes, so attach them to
        # the most recently started section covering that page. Preserve figure-only pages.
        asset_sections: dict[UUID, UUID] = {}
        for asset in assets:
            candidates = [
                section
                for section in sections
                if section.start_page <= asset.page_number <= section.end_page
            ]
            if candidates:
                section = max(candidates, key=lambda item: (item.start_page, item.ordinal))
            else:
                ordinal += 1
                section = DocumentSection(
                    id=_section_id(document_id, ordinal, asset.page_number, "Unsectioned content"),
                    document_id=document_id,
                    parent_id=None,
                    section_key=f"section-{ordinal}",
                    title="Unsectioned content",
                    level=1,
                    ordinal=ordinal,
                    start_page=asset.page_number,
                    end_page=asset.page_number,
                    detection_method="fallback",
                    confidence=1.0,
                )
                sections.append(section)
                section_nodes.append(
                    DocumentTreeNode(
                        id=uuid5(document_id, f"tree:section:{section.id}"),
                        document_id=document_id,
                        parent_id=None,
                        node_key=f"section:{section.id}",
                        node_type="section",
                        label=section.title,
                        sort_order=ordinal,
                        page_number=asset.page_number,
                        section_id=section.id,
                    )
                )
            asset.section_id = section.id
            asset_sections[asset.id] = section.id

        # A root node anchors the persisted document → section → page → block → chunk tree.
        root_id = uuid5(document_id, "tree:document")
        root = DocumentTreeNode(
            id=root_id,
            document_id=document_id,
            parent_id=None,
            node_key="document",
            node_type="document",
            label="Document",
            sort_order=0,
        )
        for section in sections:
            db.add(section)
            await db.flush()
        db.add(root)
        await db.flush()
        for node, section in zip(section_nodes, sections, strict=True):
            node.parent_id = root_id if section.parent_id is None else uuid5(
                document_id, f"tree:section:{section.parent_id}"
            )
            db.add(node)
            await db.flush()

        page_nodes: dict[tuple[UUID, int], DocumentTreeNode] = {}
        block_nodes: dict[UUID, DocumentTreeNode] = {}
        for block in blocks:
            section_id = section_by_block.get(block.id)
            if section_id is None:
                continue
            page_key = (section_id, block.page_number)
            page_node = page_nodes.get(page_key)
            if page_node is None:
                page_node = DocumentTreeNode(
                    id=uuid5(document_id, f"tree:page:{section_id}:{block.page_number}"),
                    document_id=document_id,
                    parent_id=uuid5(document_id, f"tree:section:{section_id}"),
                    node_key=f"page:{section_id}:{block.page_number}",
                    node_type="page",
                    label=f"Page {block.page_number}",
                    sort_order=block.page_number,
                    page_number=block.page_number,
                    section_id=section_id,
                )
                page_nodes[page_key] = page_node
            block_nodes[block.id] = DocumentTreeNode(
                id=uuid5(document_id, f"tree:block:{block.id}"),
                document_id=document_id,
                parent_id=page_node.id,
                node_key=f"block:{block.id}",
                node_type="block",
                label=" ".join(block.text.split())[:500],
                sort_order=block.block_index,
                page_number=block.page_number,
                section_id=section_id,
                block_id=block.id,
                content_hash=block.content_hash,
            )
        db.add_all(page_nodes.values())
        await db.flush()
        db.add_all(block_nodes.values())
        await db.flush()

        for asset in assets:
            section_id = asset_sections[asset.id]
            page_key = (section_id, asset.page_number)
            page_node = page_nodes.get(page_key)
            if page_node is None:
                page_node = DocumentTreeNode(
                    id=uuid5(document_id, f"tree:page:{section_id}:{asset.page_number}"),
                    document_id=document_id,
                    parent_id=uuid5(document_id, f"tree:section:{section_id}"),
                    node_key=f"page:{section_id}:{asset.page_number}",
                    node_type="page",
                    label=f"Page {asset.page_number}",
                    sort_order=asset.page_number,
                    page_number=asset.page_number,
                    section_id=section_id,
                )
                page_nodes[page_key] = page_node
                db.add(page_node)
                await db.flush()
            db.add(
                DocumentTreeNode(
                    id=uuid5(document_id, f"tree:asset:{asset.id}"),
                    document_id=document_id,
                    parent_id=page_node.id,
                    node_key=f"asset:{asset.id}",
                    node_type="asset",
                    label=f"{asset.asset_type} ({asset.media_type})",
                    sort_order=asset.page_number,
                    page_number=asset.page_number,
                    section_id=section_id,
                    asset_id=asset.id,
                    content_hash=asset.content_hash,
                )
            )

        for block in blocks:
            parts = split_text(block.text)
            for i, content in enumerate(parts):
                key = f"{block.id}:{i}"
                chunk_id = uuid5(document_id, f"chunk:{key}")
                section_id = section_by_block.get(block.id)
                db.add(
                    DocumentChunk(
                        id=chunk_id,
                        document_id=document_id,
                        page_number=block.page_number,
                        block_id=block.id,
                        section_id=section_id,
                        chunk_key=key,
                        chunk_index=i,
                        content=content,
                        content_hash=hashlib.sha256(content.encode("utf-8")).hexdigest(),
                        token_count=len(content.split()),
                        bbox=block.bbox,
                    )
                )
                block_node = block_nodes.get(block.id)
                if block_node:
                    db.add(
                        DocumentTreeNode(
                            id=uuid5(document_id, f"tree:chunk:{chunk_id}"),
                            document_id=document_id,
                            parent_id=block_node.id,
                            node_key=f"chunk:{chunk_id}",
                            node_type="chunk",
                            label=content[:500],
                            sort_order=i,
                            page_number=block.page_number,
                            section_id=section_id,
                            block_id=block.id,
                            chunk_id=chunk_id,
                            content_hash=hashlib.sha256(content.encode("utf-8")).hexdigest(),
                        )
                    )
                count += 1
        await db.commit()
        vector_count = 0
        if embedding_enabled(settings) and count:
            try:
                for start in range(0, count, 64):
                    batch = list(
                        (
                            await db.scalars(
                                select(DocumentChunk)
                                .where(DocumentChunk.document_id == document_id)
                                .order_by(DocumentChunk.page_number, DocumentChunk.chunk_index)
                                .offset(start)
                                .limit(64)
                            )
                        ).all()
                    )
                    batch_text = [chunk.content for chunk in batch]
                    trace_id = uuid4().hex
                    prompt_hash = hashlib.sha256(
                        "\n".join(batch_text).encode("utf-8")
                    ).hexdigest()
                    provider_started = time.perf_counter()
                    try:
                        vectors = await OpenAICompatibleEmbeddings(settings).embed_texts(batch_text)
                    except EmbeddingProviderError as exc:
                        db.add(
                            ProviderRequest(
                                trace_id=trace_id,
                                provider="openai_compatible",
                                model=settings.embedding_model,
                                operation="embeddings",
                                status="failed",
                                latency_ms=(time.perf_counter() - provider_started) * 1000,
                                prompt_hash=prompt_hash,
                                error_code=type(exc).__name__,
                            )
                        )
                        await db.commit()
                        raise
                    response_hash = hashlib.sha256(
                        json.dumps(vectors, separators=(",", ":")).encode("utf-8")
                    ).hexdigest()
                    db.add(
                        ProviderRequest(
                            trace_id=trace_id,
                            provider="openai_compatible",
                            model=settings.embedding_model,
                            operation="embeddings",
                            status="completed",
                            latency_ms=(time.perf_counter() - provider_started) * 1000,
                            prompt_hash=prompt_hash,
                            response_hash=response_hash,
                            input_tokens=None,
                            output_tokens=None,
                        )
                    )
                    db.add_all(
                        DocumentEmbedding(
                            chunk_id=chunk.id,
                            document_id=document_id,
                            model=settings.embedding_model,
                            dimensions=settings.embedding_dimensions,
                            embedding=vector,
                            updated_at=datetime.now(UTC),
                        )
                        for chunk, vector in zip(batch, vectors, strict=True)
                    )
                    await db.commit()
                    vector_count += len(batch)
            except EmbeddingProviderError:
                await db.rollback()
                async with factory() as cleanup:
                    await cleanup.execute(
                        delete(DocumentEmbedding).where(
                            DocumentEmbedding.document_id == document_id
                        )
                    )
                    await cleanup.commit()
        document = await db.get(Document, document_id)
        document.indexed_chunk_count = count
        document.index_status = "ready"
        document.index_mode = "hybrid" if vector_count == count and count > 0 else "lexical_only"
        if embedding_enabled(settings) and vector_count != count:
            document.warnings = list(document.warnings or []) + ["EMBEDDING_INDEX_UNAVAILABLE"]
        document.status = (
            DocumentStatus.READY
            if document.completeness_status == "complete"
            else DocumentStatus.DEGRADED
        )
        await db.commit()

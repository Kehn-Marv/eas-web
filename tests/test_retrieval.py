import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from packages.shared.db import Base
from packages.shared.embeddings import embed_texts
from packages.shared.evaluation import evaluate_benchmark, evaluate_case
from packages.shared.models import (
    Document,
    DocumentAsset,
    DocumentBlock,
    DocumentEmbedding,
    DocumentSection,
    DocumentStatus,
    DocumentTreeNode,
    LearningSession,
    ProviderRequest,
)
from packages.shared.retrieval import (
    lexical_score,
    reciprocal_rank_fusion,
    rerank_score,
    rewrite_query,
)
from services.api.eas_api.config import Settings
from services.worker.eas_worker import indexing


def test_lexical_score_rewards_term_coverage_and_rrf_combines_rankings():
    assert lexical_score("force and motion", "force creates motion") > lexical_score(
        "force and motion", "force"
    )
    fused = reciprocal_rank_fusion(["lexical-only", "shared"], ["shared", "vector-only"])
    assert fused[0][1] == "shared"


def test_query_rewriting_and_reranking_are_bounded_and_prefer_grounded_matches():
    variants = rewrite_query("Explain the effect of force", max_variants=3)
    assert len(variants) == 3
    assert variants[0] == "explain the effect of force"
    direct = rerank_score("force", "force causes motion", "Forces", 0.02)
    irrelevant = rerank_score("force", "gravity and mass", "Gravity", 0.02)
    assert direct > irrelevant


def test_retrieval_evaluation_measures_recall_citations_and_page_accuracy():
    case = {
        "relevant_chunk_ids": ["a", "b"],
        "retrieved_chunk_ids": ["a", "c", "b"],
        "relevant_pages": [["doc-1", 2]],
        "relevant_citations": [["doc-1", 2, "block-1", "chunk-1"]],
        "retrieved_citations": [
            ["doc-1", 2, "block-1", "chunk-1"],
            ["doc-2", 9, "block-2", "chunk-2"],
        ],
    }
    metrics = evaluate_case(case, k=2)
    assert metrics["recall@2"] == 0.5
    assert metrics["citation_precision"] == 0.5
    assert metrics["citation_recall"] == 1.0
    assert metrics["page_accuracy"] == 0.5
    aggregate = evaluate_benchmark({"name": "tiny", "k": 2, "cases": [{"id": "x", **case}]})
    assert aggregate["case_count"] == 1


@pytest.mark.asyncio
async def test_embedding_provider_validates_and_orders_embeddings(monkeypatch):
    async def handler(request):
        assert request.headers["authorization"] == "Bearer test-secret"
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 1, "embedding": [0.0] * 384},
                    {"index": 0, "embedding": [1.0] * 384},
                ]
            },
        )

    client_class = httpx.AsyncClient

    def mock_client(**kwargs):
        return client_class(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", mock_client)
    settings = Settings(
        embedding_api_url="https://embed.example/v1/embeddings",
        embedding_api_key=SecretStr("test-secret"),
    )
    vectors = await embed_texts(["first", "second"], settings)
    assert vectors[0][0] == 1.0
    assert vectors[1][0] == 0.0


@pytest.mark.asyncio
async def test_indexer_persists_embeddings_when_provider_is_available(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        learner = LearningSession()
        db.add(learner)
        await db.flush()
        document = Document(
            session_id=learner.id,
            filename="lesson.pdf",
            media_type="application/pdf",
            content_hash="a" * 64,
            object_key="test/lesson.pdf",
            byte_size=1,
            status=DocumentStatus.BUILDING_INDEX,
            completeness_status="complete",
        )
        db.add(document)
        await db.flush()
        db.add_all(
            [
                DocumentBlock(
                    document_id=document.id,
                    page_number=1,
                    block_index=0,
                    source_type="paragraph",
                    text="1 Forces",
                    content_hash="c" * 64,
                ),
                DocumentBlock(
                    document_id=document.id,
                    page_number=1,
                    block_index=1,
                    source_type="paragraph",
                    text="Gravity attracts objects with mass.",
                    content_hash="b" * 64,
                ),
                DocumentBlock(
                    document_id=document.id,
                    page_number=2,
                    block_index=0,
                    source_type="paragraph",
                    text="1.1 Gravity",
                    content_hash="d" * 64,
                ),
                DocumentBlock(
                    document_id=document.id,
                    page_number=2,
                    block_index=1,
                    source_type="paragraph",
                    text="Gravity attracts objects with mass.",
                    content_hash="e" * 64,
                ),
                DocumentBlock(
                    document_id=document.id,
                    page_number=2,
                    block_index=2,
                    source_type="table",
                    text="Mass\tForce\n2 kg\t19.6 N",
                    content_hash="g" * 64,
                ),
            ]
        )
        figure = DocumentAsset(
            document_id=document.id,
            page_number=2,
            asset_type="image",
            object_key="test/lesson-page-2-image.png",
            media_type="image/png",
            content_hash="f" * 64,
            byte_size=10,
        )
        db.add(figure)
        await db.commit()
        document_id = document.id
        figure_id = figure.id

    async def fake_embeddings(_provider, texts):
        return [[1.0] + [0.0] * 383 for _ in texts]

    monkeypatch.setattr(indexing.OpenAICompatibleEmbeddings, "embed_texts", fake_embeddings)
    settings = Settings(
        embedding_api_url="https://embed.example/v1/embeddings",
        embedding_api_key=SecretStr("test-secret"),
    )
    await indexing.index_document({"document_id": str(document_id)}, engine, settings)
    async with factory() as db:
        embedding = await db.scalar(select(DocumentEmbedding))
        document = await db.get(Document, document_id)
        sections = list((await db.scalars(select(DocumentSection))).all())
        nodes = list((await db.scalars(select(DocumentTreeNode))).all())
        figure = await db.get(DocumentAsset, figure_id)
        table_block = await db.scalar(
            select(indexing.DocumentBlock).where(indexing.DocumentBlock.source_type == "table")
        )
        assert embedding is not None
        provider_request = await db.scalar(select(ProviderRequest))
        assert provider_request is not None
        assert provider_request.operation == "embeddings"
        assert provider_request.status == "completed"
        assert embedding.embedding[0] == 1.0
        assert document.index_mode == "hybrid"
        assert len(sections) == 2
        subsection = next(section for section in sections if section.title == "Gravity")
        assert subsection.parent_id == next(
            section.id for section in sections if section.title == "Forces"
        )
        assert figure is not None and figure.section_id == subsection.id
        assert table_block is not None and table_block.section_id == subsection.id
        assert all(chunk.section_id is not None for chunk in (await db.scalars(
            select(indexing.DocumentChunk)
        )).all())
        assert {node.node_type for node in nodes} >= {
            "document", "section", "page", "block", "chunk", "asset"
        }
        asset_node = next(node for node in nodes if node.asset_id == figure_id)
        assert asset_node.section_id == subsection.id
        assert asset_node.parent_id in {node.id for node in nodes if node.node_type == "page"}
    await engine.dispose()

"""Grounded learner turns and a resumable-contract SSE response."""

import asyncio
import hashlib
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from opentelemetry import trace
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from packages.contracts.responses import CitationResponse, GroundedResponse
from packages.schemas.visualizations import VisualizationSpec, validate_source_references
from packages.shared.db import make_session_factory
from packages.shared.generation import LLMProviderError, llm_enabled
from packages.shared.models import (
    AgentRun,
    AgentStep,
    Document,
    LearningSession,
    LearningSignal,
    MicroCheck,
    ProviderRequest,
    Turn,
    VisualizationArtifact,
)
from packages.shared.orchestration import plan_request
from packages.shared.understanding import build_source_recall_check
from packages.shared.visualization import build_visualization_spec, visualization_hash
from services.api.eas_api.retrieval import SearchRequest, normalize_query, search_session

router = APIRouter(prefix="/v1")
logger = logging.getLogger("eas.turns")


class TurnCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=2000)
    document_ids: list[UUID] = Field(default_factory=list, max_length=20)
    mode: Literal["ADAPTIVE", "INTERACTIVE"] | None = None


class _GeneratedAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=12000)
    citation_chunk_ids: list[UUID] = Field(default_factory=list, max_length=20)


def _citation(hit) -> CitationResponse:
    return CitationResponse(
        document_id=hit.document_id,
        page_number=hit.page_number,
        section_id=hit.section_id,
        block_id=hit.block_id,
        chunk_id=hit.chunk_id,
        quote_or_excerpt=hit.content[:500],
        source_url=f"/v1/documents/{hit.document_id}/pages/{hit.page_number}",
    )


def _grounded_response(
    turn: Turn,
    trace_id: str,
    visualizations: list[VisualizationSpec] | None = None,
    visualization_ids: list[UUID] | None = None,
    checks: list[dict[str, object]] | None = None,
) -> GroundedResponse:
    return GroundedResponse(
        turn_id=turn.id,
        query=turn.query,
        text=turn.response_text,
        citations=[CitationResponse.model_validate(item) for item in turn.citations],
        learning_state=turn.learning_state,
        mode=turn.mode,
        visualizations=visualizations or [],
        visualization_ids=visualization_ids or [],
        checks=checks or [],
        warnings=turn.warnings,
        suggested_actions=turn.suggested_actions,
        trace_id=turn.trace_id or trace_id,
    )


def _check_contract(check: MicroCheck) -> dict[str, object]:
    return {
        "check_id": str(check.id),
        "concept_id": check.concept_id,
        "check_type": check.check_type,
        "question": check.question,
        "options": check.options,
        "source_refs": check.source_refs,
        "answered": check.answered_at is not None,
    }


def _fallback_text(hits) -> str:
    if not hits:
        return (
            "I could not find a relevant passage in the indexed study materials. "
            "Try another question or add the relevant document."
        )
    excerpt = hits[0].content.strip().replace("\n", " ")
    if len(excerpt) > 500:
        excerpt = excerpt[:497].rstrip() + "..."
    return f"The most relevant passage in your material says: “{excerpt}”"


async def _create_or_reuse_turn(
    request: Request,
    session_id: UUID,
    body: TurnCreateRequest,
    request_key: str,
    on_text_delta=None,
) -> GroundedResponse:
    settings = request.app.state.settings
    request_hash = hashlib.sha256(
        json.dumps(
            {
                "query": body.query.strip(),
                "document_ids": sorted(str(value) for value in body.document_ids),
                "mode": body.mode,
            },
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        learner = await db.get(LearningSession, session_id)
        if learner is None:
            raise HTTPException(
                404, detail={"code": "SESSION_NOT_FOUND", "message": "Session not found."}
            )
        turn = await db.scalar(select(Turn).where(Turn.idempotency_key == request_key))
        if turn:
            if turn.session_id != session_id or turn.request_hash != request_hash:
                raise HTTPException(
                    409,
                    detail={
                        "code": "IDEMPOTENCY_CONFLICT",
                        "message": "That key was used for a different turn.",
                    },
                )
            artifacts = list(
                (
                    await db.scalars(
                        select(VisualizationArtifact).where(
                            VisualizationArtifact.turn_id == turn.id
                        )
                    )
                ).all()
            )
            checks = list(
                (await db.scalars(select(MicroCheck).where(MicroCheck.turn_id == turn.id))).all()
            )
            return _grounded_response(
                turn,
                request.state.request_id,
                [VisualizationSpec.model_validate(item.spec) for item in artifacts],
                [item.id for item in artifacts],
                [_check_contract(item) for item in checks],
            )
        mode = body.mode or learner.learning_mode
        if body.mode is not None:
            learner.learning_mode = body.mode
        learner.last_active_at = datetime.now(UTC)
        session_has_documents = bool(
            await db.scalar(
                select(Document.id).where(Document.session_id == session_id).limit(1)
            )
        )
        previous_turns = list(
            (
                await db.execute(
                    select(Turn.query, Turn.response_text)
                    .where(Turn.session_id == session_id)
                    .order_by(Turn.created_at.desc())
                    .limit(6)
                )
            ).all()
        )
        recent_checks = list(
            (
                await db.scalars(
                    select(MicroCheck)
                    .where(
                        MicroCheck.session_id == session_id,
                        MicroCheck.answered_at.is_not(None),
                    )
                    .order_by(MicroCheck.answered_at.desc())
                    .limit(3)
                )
            ).all()
        )
        await db.commit()
    normalized_query = normalize_query(body.query)
    repeated_count = sum(
        normalize_query(previous_query) == normalized_query
        for previous_query, _previous_response in previous_turns
    )
    plan = plan_request(
        body.query,
        settings,
        repeated_concept_questions=repeated_count,
        failed_checkpoints=sum(check.correctness is False for check in recent_checks),
        confidence=next(
            (check.confidence for check in recent_checks if check.confidence is not None), None
        ),
        explicit_visual_request=mode == "INTERACTIVE",
    )

    with trace.get_tracer("eas.retrieval").start_as_current_span("retrieval.search") as span:
        span.set_attribute("eas.session_id", str(session_id))
        search_response = await search_session(
            request,
            session_id,
            SearchRequest(query=body.query, document_ids=body.document_ids),
        )
        span.set_attribute("eas.retrieval.result_count", len(search_response.hits))
    context_chunk_ids = {
        UUID(chunk_id)
        for source in search_response.context_sources
        for chunk_id in source.get("chunk_ids", [])
    }
    candidates = [hit for hit in search_response.hits if hit.chunk_id in context_chunk_ids]
    warnings: list[str] = []
    suggested_actions: list[str] = []
    wants_visualization = (
        plan.classification.explicit_visual_request or plan.decision.level.value >= 2
    )
    if plan.decision.level.value == 1:
        suggested_actions.append("A diagram or worked example may help with this question.")
    elif wants_visualization:
        suggested_actions.append("Try a diagram or worked example for this concept.")
    if plan.decision.level.value >= 3:
        suggested_actions.append("Check your understanding with a short practice question.")
    citations: list[CitationResponse] = []
    response_text: str
    provider_started = time.perf_counter()
    provider_raw: str | None = None
    provider_error: str | None = None
    source_free_chat = not session_has_documents
    provider_attempted = bool(llm_enabled(settings) and (candidates or source_free_chat))
    if not candidates and source_free_chat and llm_enabled(settings):
        try:
            provider_raw = await request.app.state.llm_provider.generate(
                body.query,
                [],
                conversation_history=[
                    {"query": previous_query, "response": previous_response}
                    for previous_query, previous_response in reversed(previous_turns)
                ],
                on_text_delta=on_text_delta,
            )
            generated = _GeneratedAnswer.model_validate_json(provider_raw)
            if generated.citation_chunk_ids:
                raise ValueError("A general answer cannot cite unavailable source chunks")
            response_text = generated.text
            warnings.append("UNSOURCED_GENERAL_RESPONSE")
        except (LLMProviderError, ValidationError, ValueError) as exc:
            provider_error = type(exc).__name__
            response_text = "I couldn't complete that answer just now. Please try again."
            warnings.append("GENERAL_GENERATION_FAILED")
    elif not candidates and source_free_chat:
        response_text = (
            "Direct chat is temporarily unavailable because EAS's language model isn't configured. "
            "You can still upload material for source-grounded explanations."
        )
        warnings.append("GENERATION_PROVIDER_NOT_CONFIGURED")
    elif not candidates:
        response_text = _fallback_text([])
        warnings.append("NO_RELEVANT_SOURCE")
    elif llm_enabled(settings):
        try:
            provider_raw = await request.app.state.llm_provider.generate(
                body.query,
                [
                    {
                        "chunk_id": str(hit.chunk_id),
                        "document_id": str(hit.document_id),
                        "page_number": hit.page_number,
                        "content": hit.content,
                    }
                    for hit in candidates
                ],
                conversation_history=[
                    {"query": previous_query, "response": previous_response}
                    for previous_query, previous_response in reversed(previous_turns)
                ],
                on_text_delta=on_text_delta,
            )
            generated = _GeneratedAnswer.model_validate_json(provider_raw)
            if not generated.citation_chunk_ids:
                raise ValueError("A source-grounded answer must cite its supporting chunks")
            by_id = {hit.chunk_id: hit for hit in candidates}
            if any(source_id not in by_id for source_id in generated.citation_chunk_ids):
                raise ValueError("Model cited a source outside the retrieved context")
            unique_ids = list(dict.fromkeys(generated.citation_chunk_ids))
            citations = [_citation(by_id[source_id]) for source_id in unique_ids]
            response_text = generated.text
        except (LLMProviderError, ValidationError, ValueError) as exc:
            provider_error = type(exc).__name__
            response_text = _fallback_text(candidates)
            citations = [_citation(candidates[0])]
            warnings.append("GENERATION_FALLBACK_EXTRACTIVE")
    else:
        response_text = _fallback_text(candidates)
        citations = [_citation(candidates[0])]
        warnings.append("GENERATION_PROVIDER_NOT_CONFIGURED")

    visualizations: list[VisualizationSpec] = []
    generated_check: dict[str, object] | None = None
    wants_check = plan.decision.level.value >= 3
    if wants_visualization:
        if candidates:
            try:
                spec = build_visualization_spec(body.query, candidates)
                available_sources = {
                    (hit.document_id, hit.page_number, hit.block_id, hit.chunk_id)
                    for hit in candidates
                }
                if not validate_source_references(spec, available_sources):
                    raise ValueError("Visualization cited a source outside retrieved context")
                visualizations.append(spec)
            except (ValidationError, ValueError):
                warnings.append("VISUALIZATION_GENERATION_UNAVAILABLE")
        else:
            warnings.append("VISUALIZATION_GENERATION_UNAVAILABLE")
    if wants_check:
        generated_check = (
            build_source_recall_check(body.query, candidates[0]) if candidates else None
        )
        if generated_check is None:
            warnings.append("AUTOMATIC_CHECK_GENERATION_UNAVAILABLE")

    created_visualization_ids: list[UUID] = []
    check_contracts: list[dict[str, object]] = []
    async with factory() as db:
        turn = Turn(
            session_id=session_id,
            idempotency_key=request_key,
            request_hash=request_hash,
            trace_id=request.state.request_id,
            query=body.query,
            response_text=response_text,
            citations=[citation.model_dump(mode="json") for citation in citations],
            mode=mode if mode in {"ADAPTIVE", "INTERACTIVE"} else "ADAPTIVE",
            learning_state={
                "learning_friction_score": plan.decision.score,
                "policy_level": plan.decision.level.name,
                "reason_codes": list(plan.decision.reason_codes),
                "orchestration_steps": list(plan.steps),
            },
            warnings=warnings,
            suggested_actions=suggested_actions
            or (
                ["Upload relevant material or choose an indexed document."]
                if not candidates
                else ["Ask a follow-up question or request a worked example."]
            ),
            status="completed",
        )
        db.add(turn)
        await db.flush()
        run = AgentRun(
            session_id=session_id,
            turn_id=turn.id,
            trace_id=turn.trace_id,
            status="completed",
            metadata_json={
                "friction_score": plan.decision.score,
                "policy_level": plan.decision.level.name,
            },
        )
        db.add(run)
        await db.flush()
        query_hash = hashlib.sha256(body.query.encode("utf-8")).hexdigest()
        answer_hash = hashlib.sha256(response_text.encode("utf-8")).hexdigest()
        db.add_all(
            AgentStep(
                agent_run_id=run.id,
                sequence=index,
                step_name=step,
                status="completed",
                provider="openai_compatible"
                if step == "content_generation" and provider_attempted
                else None,
                model=settings.llm_model
                if step == "content_generation" and provider_attempted
                else None,
                latency_ms=round((time.perf_counter() - provider_started) * 1000, 2)
                if step == "content_generation" and provider_attempted
                else None,
                input_hash=query_hash,
                output_hash=hashlib.sha256(f"{step}:{answer_hash}".encode()).hexdigest(),
                details={"fallback_used": bool(warnings)},
            )
            for index, step in enumerate(plan.steps, start=1)
        )
        db.add_all(
            LearningSignal(
                session_id=session_id,
                turn_id=turn.id,
                signal_type=reason,
                strength=plan.decision.score,
                source="adaptive_policy",
                details={"policy_level": plan.decision.level.name},
            )
            for reason in plan.decision.reason_codes
        )
        if provider_attempted:
            db.add(
                ProviderRequest(
                    trace_id=turn.trace_id,
                    turn_id=turn.id,
                    provider="openai_compatible",
                    model=settings.llm_model,
                    operation="grounded_generation",
                    status="failed" if provider_error else "completed",
                    latency_ms=round((time.perf_counter() - provider_started) * 1000, 2),
                    prompt_hash=query_hash,
                    response_hash=hashlib.sha256(provider_raw.encode()).hexdigest()
                    if provider_raw
                    else None,
                    error_code=provider_error,
                )
            )
        for spec in visualizations:
            source_refs = [ref.model_dump(mode="json") for ref in spec.source_refs]
            artifact_id = uuid.uuid4()
            source_document_ids = {ref.document_id for ref in spec.source_refs}
            artifact_document_id = (
                next(iter(source_document_ids)) if len(source_document_ids) == 1 else None
            )
            db.add(
                VisualizationArtifact(
                    id=artifact_id,
                    session_id=session_id,
                    turn_id=turn.id,
                    document_id=artifact_document_id,
                    schema_version=spec.schema_version,
                    visual_type=spec.type.value,
                    spec=spec.model_dump(mode="json"),
                    source_refs=source_refs,
                    content_hash=visualization_hash(spec),
                )
            )
            created_visualization_ids.append(artifact_id)
        if generated_check is not None:
            check = MicroCheck(
                session_id=session_id,
                turn_id=turn.id,
                idempotency_key=f"{turn.id}:automatic-check",
                concept_id=str(generated_check["concept_id"]),
                check_type=str(generated_check["check_type"]),
                question=str(generated_check["question"]),
                options=None,
                expected_answer=generated_check["expected_answer"],
                tolerance=0.0,
                source_refs=generated_check["source_refs"],
                representation_used=str(generated_check["representation_used"]),
            )
            db.add(check)
            await db.flush()
            check_contracts.append(_check_contract(check))
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            existing = await db.scalar(select(Turn).where(Turn.idempotency_key == request_key))
            if existing is None or existing.request_hash != request_hash:
                raise HTTPException(
                    409,
                    detail={
                        "code": "IDEMPOTENCY_CONFLICT",
                        "message": "That key was used for a different turn.",
                    },
                ) from None
            artifacts = list(
                (
                    await db.scalars(
                        select(VisualizationArtifact).where(
                            VisualizationArtifact.turn_id == existing.id
                        )
                    )
                ).all()
            )
            checks = list(
                (
                    await db.scalars(select(MicroCheck).where(MicroCheck.turn_id == existing.id))
                ).all()
            )
            return _grounded_response(
                existing,
                request.state.request_id,
                [VisualizationSpec.model_validate(item.spec) for item in artifacts],
                [item.id for item in artifacts],
                [_check_contract(item) for item in checks],
            )
        await db.refresh(turn)
        return _grounded_response(
            turn,
            request.state.request_id,
            visualizations,
            created_visualization_ids,
            check_contracts,
        )


@router.post("/sessions/{session_id}/turns")
async def create_turn(
    request: Request,
    session_id: UUID,
    body: TurnCreateRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=128)] = None,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> StreamingResponse:
    try:
        owner_id = UUID(request.cookies.get("eas_session", ""))
    except ValueError as exc:
        raise HTTPException(
            401, detail={"code": "UNAUTHORIZED", "message": "Create a study session first."}
        ) from exc
    if owner_id != session_id:
        raise HTTPException(
            404, detail={"code": "SESSION_NOT_FOUND", "message": "Session not found."}
        )
    request_key = f"{session_id}:turn:{idempotency_key or uuid.uuid4()}"
    async def event_stream() -> AsyncIterator[str]:
        queue: asyncio.Queue[tuple[str, object]] = asyncio.Queue()

        async def on_delta(value: str) -> None:
            await queue.put(("delta", value))

        cursor = max(0, int(last_event_id)) if last_event_id and last_event_id.isdigit() else 0
        force_replace = False

        async def produce() -> None:
            nonlocal force_replace
            started = time.perf_counter()
            try:
                factory = make_session_factory(request.app.state.db_engine)
                async with factory() as db:
                    prior = await db.scalar(
                        select(Turn).where(Turn.idempotency_key == request_key)
                    )
                force_replace = bool(cursor and prior is None)
                result = await _create_or_reuse_turn(
                    request,
                    session_id,
                    body,
                    request_key,
                    on_text_delta=None if force_replace else on_delta,
                )
                await queue.put(("complete", result))
                logger.info(
                    "turn.completed",
                    extra={
                        "request_id": request.state.request_id,
                        "session_id": str(session_id),
                        "turn_id": str(result.turn_id),
                        "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                        "retrieval_count": len(result.citations),
                        "validation_status": "warning" if result.warnings else "passed",
                    },
                )
            except Exception as exc:
                logger.warning("turn.stream_failed error_type=%s", type(exc).__name__)
                await queue.put(("error", exc))

        producer = asyncio.create_task(produce())
        emitted = 0
        streamed = False
        try:
            while True:
                try:
                    kind, value = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if kind == "delta":
                    streamed = True
                    text_delta = str(value)
                    start = emitted
                    emitted += len(text_delta)
                    if emitted <= cursor:
                        continue
                    if start < cursor:
                        text_delta = text_delta[cursor - start :]
                    data = json.dumps({"text": text_delta}, ensure_ascii=False)
                    yield f"id: {emitted}\nevent: delta\ndata: {data}\n\n"
                elif kind == "complete":
                    result = value
                    assert isinstance(result, GroundedResponse)
                    if force_replace:
                        replacement = json.dumps({"text": result.text}, ensure_ascii=False)
                        emitted = len(result.text)
                        yield f"id: {emitted}\nevent: replace\ndata: {replacement}\n\n"
                    elif not streamed:
                        remaining = result.text[cursor:]
                        for offset in range(0, len(remaining), 120):
                            chunk = remaining[offset : offset + 120]
                            emitted = cursor + offset + len(chunk)
                            data = json.dumps({"text": chunk}, ensure_ascii=False)
                            yield f"id: {emitted}\nevent: delta\ndata: {data}\n\n"
                    elif emitted != len(result.text):
                        # The provider may have streamed JSON text that failed final validation.
                        replacement = json.dumps({"text": result.text}, ensure_ascii=False)
                        emitted = len(result.text)
                        yield f"id: {emitted}\nevent: replace\ndata: {replacement}\n\n"
                    final_id = len(result.text) + 1
                    final_json = result.model_dump_json()
                    yield f"id: {final_id}\nevent: final\ndata: {final_json}\n\n"
                    break
                else:
                    data = json.dumps({
                        "code": "TURN_GENERATION_FAILED",
                        "message": "The turn could not be completed.",
                    })
                    yield f"event: error\ndata: {data}\n\n"
                    break
        finally:
            if not producer.done():
                producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/sessions/{session_id}/turns")
async def list_turns(request: Request, session_id: UUID, limit: int = 20) -> list[GroundedResponse]:
    try:
        owner_id = UUID(request.cookies.get("eas_session", ""))
    except ValueError as exc:
        raise HTTPException(
            401, detail={"code": "UNAUTHORIZED", "message": "Create a study session first."}
        ) from exc
    if owner_id != session_id:
        raise HTTPException(
            404, detail={"code": "SESSION_NOT_FOUND", "message": "Session not found."}
        )
    if not 1 <= limit <= 100:
        raise HTTPException(
            422, detail={"code": "INVALID_LIMIT", "message": "Limit must be 1–100."}
        )
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        turns = list(
            (
                await db.scalars(
                    select(Turn)
                    .where(Turn.session_id == session_id)
                    .order_by(Turn.created_at.desc())
                    .limit(limit)
                )
            ).all()
        )
        turn_ids = [turn.id for turn in turns]
        artifacts = (
            list(
                (
                    await db.scalars(
                        select(VisualizationArtifact).where(
                            VisualizationArtifact.turn_id.in_(turn_ids)
                        )
                    )
                ).all()
            )
            if turn_ids
            else []
        )
        checks = (
            list(
                (await db.scalars(select(MicroCheck).where(MicroCheck.turn_id.in_(turn_ids)))).all()
            )
            if turn_ids
            else []
        )
        visualizations_by_turn: dict[UUID, list[VisualizationSpec]] = {}
        for artifact in artifacts:
            visualizations_by_turn.setdefault(artifact.turn_id, []).append(
                VisualizationSpec.model_validate(artifact.spec)
            )
        checks_by_turn: dict[UUID, list[dict[str, object]]] = {}
        for check in checks:
            if check.turn_id is not None:
                checks_by_turn.setdefault(check.turn_id, []).append(_check_contract(check))
        return [
            _grounded_response(
                turn,
                request.state.request_id,
                visualizations_by_turn.get(turn.id, []),
                [item.id for item in artifacts if item.turn_id == turn.id],
                checks_by_turn.get(turn.id, []),
            )
            for turn in turns
        ]

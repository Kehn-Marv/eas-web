"""Session-owned understanding checks and lightweight learning-state endpoints."""

from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select

from packages.shared.adaptive import (
    FrictionSignals,
    RepresentationLevel,
    adaptive_decision,
)
from packages.shared.db import make_session_factory
from packages.shared.models import (
    Document,
    DocumentBlock,
    LearningSession,
    LearningSignal,
    LearningState,
    MicroCheck,
)
from packages.shared.understanding import evaluate_answer

router = APIRouter(prefix="/v1")


class SourceReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: UUID
    page_number: int = Field(ge=1)
    block_id: UUID


class CheckCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    concept_id: str = Field(min_length=1, max_length=255)
    check_type: Literal[
        "multiple_choice",
        "choose_next_step",
        "identify_relationship",
        "reorder_steps",
        "numeric",
        "short_answer",
    ]
    question: str = Field(min_length=1, max_length=2000)
    options: list[str] | None = Field(default=None, max_length=20)
    expected_answer: str | float | list[str]
    tolerance: float = Field(default=0, ge=0, le=1e9)
    source_refs: list[SourceReference] = Field(min_length=1, max_length=10)
    representation_used: str = Field(default="normal_response", max_length=64)

    @model_validator(mode="after")
    def validate_options(self):
        if self.check_type == "multiple_choice" and not self.options:
            raise ValueError("Multiple-choice checks require options")
        if self.check_type == "reorder_steps" and not isinstance(self.expected_answer, list):
            raise ValueError("Reorder checks require an ordered expected answer")
        return self


class CheckResponse(BaseModel):
    check_id: UUID
    concept_id: str
    check_type: str
    question: str
    options: list[str] | None
    source_refs: list[dict[str, object]]
    answered: bool = False


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str | float | list[str] = Field(max_length=4000)
    confidence: float | None = Field(default=None, ge=0, le=1)
    time_to_answer_seconds: int | None = Field(default=None, ge=0, le=86400)


class AnswerResponse(BaseModel):
    check_id: UUID
    correctness: bool
    friction_score: float
    recommended_representation: str
    reason_codes: list[str]


class LearningStateResponse(BaseModel):
    concept_id: str
    attempt_count: int
    correct_count: int
    incorrect_count: int
    confidence_history: list[float]
    representation_history: list[dict[str, object]]
    successful_representation: str | None
    recent_friction_score: float
    last_seen: datetime


def _session_owner(request: Request, session_id: UUID) -> None:
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


def _check_response(check: MicroCheck) -> CheckResponse:
    return CheckResponse(
        check_id=check.id,
        concept_id=check.concept_id,
        check_type=check.check_type,
        question=check.question,
        options=check.options,
        source_refs=check.source_refs,
        answered=check.answered_at is not None,
    )


@router.post("/sessions/{session_id}/checks", response_model=CheckResponse, status_code=201)
async def create_check(
    request: Request,
    session_id: UUID,
    body: CheckCreate,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=128)] = None,
) -> CheckResponse:
    _session_owner(request, session_id)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        if await db.get(LearningSession, session_id) is None:
            raise HTTPException(
                404, detail={"code": "SESSION_NOT_FOUND", "message": "Session not found."}
            )
        for ref in body.source_refs:
            valid = await db.scalar(
                select(DocumentBlock.id)
                .join(Document, Document.id == DocumentBlock.document_id)
                .where(
                    DocumentBlock.id == ref.block_id,
                    DocumentBlock.document_id == ref.document_id,
                    DocumentBlock.page_number == ref.page_number,
                    Document.session_id == session_id,
                )
            )
            if valid is None:
                raise HTTPException(
                    422,
                    detail={
                        "code": "INVALID_SOURCE_REFERENCE",
                        "message": "A source reference is not available in this session.",
                    },
                )
        key = f"{session_id}:check:{idempotency_key}" if idempotency_key else None
        if key:
            existing = await db.scalar(select(MicroCheck).where(MicroCheck.idempotency_key == key))
            if existing:
                expected = body.model_dump(mode="json")
                actual = {
                    "concept_id": existing.concept_id,
                    "check_type": existing.check_type,
                    "question": existing.question,
                    "options": existing.options,
                    "expected_answer": existing.expected_answer,
                    "tolerance": existing.tolerance,
                    "source_refs": existing.source_refs,
                    "representation_used": existing.representation_used,
                }
                if expected != actual or existing.session_id != session_id:
                    raise HTTPException(
                        409,
                        detail={
                            "code": "IDEMPOTENCY_CONFLICT",
                            "message": "That key was used for a different check.",
                        },
                    )
                return _check_response(existing)
        check = MicroCheck(
            session_id=session_id,
            concept_id=body.concept_id,
            check_type=body.check_type,
            question=body.question,
            options=body.options,
            expected_answer=body.expected_answer,
            tolerance=body.tolerance,
            source_refs=[ref.model_dump(mode="json") for ref in body.source_refs],
            representation_used=body.representation_used,
            idempotency_key=key,
        )
        db.add(check)
        await db.commit()
        await db.refresh(check)
        return _check_response(check)


@router.post("/sessions/{session_id}/checks/{check_id}/answer", response_model=AnswerResponse)
async def answer_check(
    request: Request, session_id: UUID, check_id: UUID, body: AnswerRequest
) -> AnswerResponse:
    _session_owner(request, session_id)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        check = await db.scalar(
            select(MicroCheck).where(MicroCheck.id == check_id, MicroCheck.session_id == session_id)
        )
        if check is None:
            raise HTTPException(
                404, detail={"code": "CHECK_NOT_FOUND", "message": "Check not found."}
            )
        if check.answered_at is not None:
            raise HTTPException(
                409,
                detail={
                    "code": "CHECK_ALREADY_ANSWERED",
                    "message": "This check already has an answer.",
                },
            )
        correctness = evaluate_answer(
            check.check_type, check.expected_answer, body.answer, check.tolerance
        )
        state = await db.scalar(
            select(LearningState).where(
                LearningState.session_id == session_id,
                LearningState.concept_id == check.concept_id,
            )
        )
        if state is None:
            state = LearningState(session_id=session_id, concept_id=check.concept_id)
            db.add(state)
            await db.flush()
        state.attempt_count += 1
        state.correct_count += int(correctness)
        state.incorrect_count += int(not correctness)
        state.last_seen = datetime.now(UTC)
        if body.confidence is not None:
            state.confidence_history = list(state.confidence_history or [])[-19:] + [
                body.confidence
            ]
        if correctness:
            state.successful_representation = check.representation_used
        recent_failures = sum(
            not item.get("correct", False) for item in list(state.representation_history or [])[-2:]
        )
        friction_signals = FrictionSignals(
            repeated_concept_questions=min(state.incorrect_count, 3),
            failed_checkpoints=0 if correctness else recent_failures + 1,
            confidence=body.confidence,
        )
        settings = request.app.state.settings
        previous_history = list(state.representation_history or [])
        previous_level = (
            RepresentationLevel(previous_history[-1]["policy_level"])
            if previous_history
            else RepresentationLevel.NORMAL
        )
        last_change = next(
            (item["attempt"] for item in reversed(previous_history) if item.get("level_changed")),
            0,
        )
        decision = adaptive_decision(
            friction_signals,
            previous_level=previous_level,
            turns_since_change=state.attempt_count - last_change,
            thresholds=(
                settings.adaptive_low_threshold,
                settings.adaptive_medium_threshold,
                settings.adaptive_high_threshold,
            ),
            cooldown_turns=settings.adaptive_cooldown_turns,
            hysteresis=settings.adaptive_hysteresis,
        )
        state.recent_friction_score = decision.score
        state.representation_history = (
            previous_history
            + [
                {
                    "attempt": state.attempt_count,
                    "representation": check.representation_used,
                    "policy_level": int(decision.level),
                    "level_changed": decision.level != previous_level,
                    "correct": correctness,
                }
            ]
        )[-20:]
        check.learner_answer = body.answer
        check.correctness = correctness
        check.confidence = body.confidence
        check.time_to_answer_seconds = body.time_to_answer_seconds
        check.answered_at = datetime.now(UTC)
        check.learning_signal = list(decision.reason_codes) + (
            ["FAILED_CHECKPOINT"] if not correctness else []
        )
        db.add(
            LearningSignal(
                session_id=session_id,
                turn_id=check.turn_id,
                concept_id=check.concept_id,
                signal_type="checkpoint_correct" if correctness else "checkpoint_failed",
                strength=decision.score,
                source="micro_check",
                details={
                    "confidence": body.confidence,
                    "time_to_answer_seconds": body.time_to_answer_seconds,
                    "reason_codes": list(decision.reason_codes),
                },
            )
        )
        await db.commit()
        return AnswerResponse(
            check_id=check.id,
            correctness=correctness,
            friction_score=decision.score,
            recommended_representation=decision.representation,
            reason_codes=list(decision.reason_codes),
        )


@router.get(
    "/sessions/{session_id}/learning-state/{concept_id}",
    response_model=LearningStateResponse,
)
async def get_learning_state(
    request: Request, session_id: UUID, concept_id: str
) -> LearningStateResponse:
    _session_owner(request, session_id)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        state = await db.scalar(
            select(LearningState).where(
                LearningState.session_id == session_id,
                LearningState.concept_id == concept_id,
            )
        )
        if state is None:
            raise HTTPException(
                404,
                detail={"code": "LEARNING_STATE_NOT_FOUND", "message": "Learning state not found."},
            )
        return LearningStateResponse(
            concept_id=state.concept_id,
            attempt_count=state.attempt_count,
            correct_count=state.correct_count,
            incorrect_count=state.incorrect_count,
            confidence_history=state.confidence_history,
            representation_history=state.representation_history,
            successful_representation=state.successful_representation,
            recent_friction_score=state.recent_friction_score,
            last_seen=state.last_seen,
        )

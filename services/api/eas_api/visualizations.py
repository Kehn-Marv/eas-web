"""Owned visualization artifact retrieval and constrained interaction recording."""

import math
from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from packages.schemas.visualizations import VisualizationSpec
from packages.shared.db import make_session_factory
from packages.shared.models import InteractionEvent, VisualizationArtifact

router = APIRouter(prefix="/v1/visualizations")


class VisualizationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    visualization_id: UUID
    turn_id: UUID
    created_at: datetime
    spec: VisualizationSpec


class InteractionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    interaction_id: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
    value: str | int | float | bool | list[str] | None = None


class InteractionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: UUID
    visualization_id: UUID
    interaction_id: str
    target_id: str
    action: str
    state_key: str | None
    value: str | int | float | bool | list[str] | None
    created_at: datetime


def _session_id(request: Request) -> UUID:
    try:
        return UUID(request.cookies.get("eas_session", ""))
    except ValueError as exc:
        raise HTTPException(
            401, detail={"code": "UNAUTHORIZED", "message": "Create a study session first."}
        ) from exc


def _validate_interaction(interaction, value, spec: VisualizationSpec) -> object:
    if isinstance(value, float) and not math.isfinite(value):
        raise HTTPException(
            422,
            detail={"code": "INVALID_INTERACTION", "message": "Interaction value is invalid."},
        )
    if interaction.action == "set" and value is None:
        raise HTTPException(
            422,
            detail={"code": "INVALID_INTERACTION", "message": "A value is required."},
        )
    if interaction.action == "increment" and (
        not isinstance(value, (int, float)) or isinstance(value, bool)
    ):
        raise HTTPException(
            422,
            detail={"code": "INVALID_INTERACTION", "message": "A numeric value is required."},
        )
    if interaction.action == "toggle" and not isinstance(value, bool):
        raise HTTPException(
            422,
            detail={"code": "INVALID_INTERACTION", "message": "A boolean value is required."},
        )
    if interaction.action == "reorder":
        element_ids = {element.id for element in spec.visual_elements}
        if (
            not isinstance(value, list)
            or len(value) > len(element_ids)
            or len(value) != len(set(value))
            or not set(value).issubset(element_ids)
        ):
            raise HTTPException(
                422,
                detail={"code": "INVALID_INTERACTION", "message": "The order is invalid."},
            )
    if interaction.action == "select" and value is not None:
        element_ids = {element.id for element in spec.visual_elements}
        if not isinstance(value, str) or value not in element_ids:
            raise HTTPException(
                422,
                detail={"code": "INVALID_INTERACTION", "message": "The selection is invalid."},
            )
    return value


@router.get("/{visualization_id}", response_model=VisualizationResponse)
async def get_visualization(request: Request, visualization_id: UUID) -> VisualizationResponse:
    session_id = _session_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        artifact = await db.scalar(
            select(VisualizationArtifact).where(
                VisualizationArtifact.id == visualization_id,
                VisualizationArtifact.session_id == session_id,
            )
        )
        if artifact is None:
            raise HTTPException(
                404,
                detail={"code": "VISUALIZATION_NOT_FOUND", "message": "Visualization not found."},
            )
        return VisualizationResponse(
            visualization_id=artifact.id,
            turn_id=artifact.turn_id,
            created_at=artifact.created_at,
            spec=VisualizationSpec.model_validate(artifact.spec),
        )


@router.post("/{visualization_id}/interact", response_model=InteractionResponse, status_code=201)
async def interact_with_visualization(
    request: Request,
    visualization_id: UUID,
    body: InteractionRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=128)] = None,
) -> InteractionResponse:
    session_id = _session_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        artifact = await db.scalar(
            select(VisualizationArtifact).where(
                VisualizationArtifact.id == visualization_id,
                VisualizationArtifact.session_id == session_id,
            )
        )
        if artifact is None:
            raise HTTPException(
                404,
                detail={"code": "VISUALIZATION_NOT_FOUND", "message": "Visualization not found."},
            )
        spec = VisualizationSpec.model_validate(artifact.spec)
        interaction = next(
            (item for item in spec.interactions if item.id == body.interaction_id), None
        )
        if interaction is None:
            raise HTTPException(
                422,
                detail={
                    "code": "INVALID_INTERACTION",
                    "message": "That interaction is not part of this visualization.",
                },
            )
        value = _validate_interaction(interaction, body.value, spec)
        if idempotency_key:
            # A client can safely replay its latest event key for this artifact.
            existing = await db.scalar(
                select(InteractionEvent).where(
                    InteractionEvent.artifact_id == artifact.id,
                    InteractionEvent.session_id == session_id,
                    InteractionEvent.idempotency_key == idempotency_key,
                )
            )
            if existing:
                if existing.interaction_id != interaction.id or existing.value != value:
                    raise HTTPException(
                        409,
                        detail={
                            "code": "IDEMPOTENCY_CONFLICT",
                            "message": "That key was used for a different interaction.",
                        },
                    )
                return InteractionResponse(
                    event_id=existing.id,
                    visualization_id=artifact.id,
                    interaction_id=existing.interaction_id,
                    target_id=existing.target_id,
                    action=existing.action,
                    state_key=existing.state_key,
                    value=existing.value,
                    created_at=existing.created_at,
                )
        event = InteractionEvent(
            artifact_id=artifact.id,
            session_id=session_id,
            idempotency_key=idempotency_key,
            interaction_id=interaction.id,
            target_id=interaction.target_id,
            action=interaction.action,
            state_key=interaction.state_key,
            value=value,
        )
        db.add(event)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            if idempotency_key:
                existing = await db.scalar(
                    select(InteractionEvent).where(
                        InteractionEvent.artifact_id == artifact.id,
                        InteractionEvent.session_id == session_id,
                        InteractionEvent.idempotency_key == idempotency_key,
                    )
                )
                if (
                    existing is not None
                    and existing.interaction_id == interaction.id
                    and existing.value == value
                ):
                    return InteractionResponse(
                        event_id=existing.id,
                        visualization_id=artifact.id,
                        interaction_id=existing.interaction_id,
                        target_id=existing.target_id,
                        action=existing.action,
                        state_key=existing.state_key,
                        value=existing.value,
                        created_at=existing.created_at,
                    )
            raise HTTPException(
                409,
                detail={
                    "code": "IDEMPOTENCY_CONFLICT",
                    "message": "That key was already used for another interaction.",
                },
            ) from None
        await db.refresh(event)
        return InteractionResponse(
            event_id=event.id,
            visualization_id=artifact.id,
            interaction_id=event.interaction_id,
            target_id=event.target_id,
            action=event.action,
            state_key=event.state_key,
            value=event.value,
            created_at=event.created_at,
        )

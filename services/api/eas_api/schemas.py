"""Public endpoints for versioned frontend artifact schemas."""

from fastapi import APIRouter

from packages.schemas.visualizations import to_json_schema

router = APIRouter(prefix="/v1/schemas")


@router.get("/visualization/v1")
async def visualization_schema() -> dict[str, object]:
    return to_json_schema()

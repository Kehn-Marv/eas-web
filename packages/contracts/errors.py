from pydantic import BaseModel, ConfigDict, Field


class ApiError(BaseModel):
    """Stable machine-readable API error envelope."""

    model_config = ConfigDict(extra="forbid")

    code: str
    message: str
    details: dict[str, object] = Field(default_factory=dict)
    retryable: bool = False
    request_id: str | None = None

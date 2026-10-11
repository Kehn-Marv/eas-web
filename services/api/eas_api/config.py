from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "EAS API"
    environment: str = "development"
    port: int = Field(default=8000, ge=1, le=65535)
    database_url: SecretStr = SecretStr("sqlite+aiosqlite:///./eas-dev-v10.db")
    sql_echo: bool = False
    storage_backend: str = "filesystem"
    storage_root: str = "./private-objects"
    s3_bucket: str | None = None
    aws_region: str | None = None
    s3_endpoint_url: str | None = None
    max_upload_bytes: int = Field(default=50 * 1024 * 1024, ge=1024)
    max_pdf_pages: int = Field(default=500, ge=1)
    max_queued_jobs: int = Field(default=500, ge=1, le=100_000)
    max_running_jobs: int = Field(default=4, ge=1, le=256)
    rate_limit_requests: int = Field(default=120, ge=1, le=100_000)
    rate_limit_window_seconds: int = Field(default=60, ge=1, le=86_400)
    rate_limit_max_clients: int = Field(default=10_000, ge=100, le=1_000_000)
    extraction_min_chars: int = Field(default=40, ge=1)
    ocr_language: str = "eng"
    parser_backend: Literal["pymupdf", "docling", "mineru"] = "pymupdf"
    embedding_api_url: str | None = None
    embedding_api_key: SecretStr | None = None
    embedding_model: str = "text-embedding-3-small"
    embedding_dimensions: int = Field(default=384, ge=384, le=384)
    embedding_timeout_seconds: float = Field(default=30, gt=0, le=120)
    vision_api_url: str | None = None
    vision_api_key: SecretStr | None = None
    vision_model: str = "eas-vision"
    vision_timeout_seconds: float = Field(default=60, gt=0, le=180)
    llm_api_url: str | None = None
    llm_api_key: SecretStr | None = None
    llm_model: str = "eas-chat"
    llm_timeout_seconds: float = Field(default=60, gt=0, le=180)
    otel_exporter_otlp_endpoint: str | None = None
    otel_service_name: str = "eas-api"
    adaptive_low_threshold: float = Field(default=0.25, ge=0, le=1)
    adaptive_medium_threshold: float = Field(default=0.45, ge=0, le=1)
    adaptive_high_threshold: float = Field(default=0.70, ge=0, le=1)
    adaptive_cooldown_turns: int = Field(default=2, ge=0, le=20)
    adaptive_hysteresis: float = Field(default=0.08, ge=0, le=0.5)

    @model_validator(mode="after")
    def validate_adaptive_thresholds(self):
        if not (
            self.adaptive_low_threshold
            < self.adaptive_medium_threshold
            < self.adaptive_high_threshold
        ):
            raise ValueError("Adaptive thresholds must increase from low to high")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()

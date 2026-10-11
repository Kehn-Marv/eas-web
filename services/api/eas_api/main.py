import logging
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from opentelemetry import trace
from opentelemetry.context import attach, detach
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.propagate import extract
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from sqlalchemy import case, delete, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from packages.contracts.errors import ApiError
from packages.contracts.responses import HealthResponse, ReadinessResponse
from packages.shared import models as _models  # noqa: F401
from packages.shared.db import Base, check_database, make_engine, make_session_factory
from packages.shared.generation import OpenAICompatibleLLM
from packages.shared.models import RateLimitBucket
from packages.shared.storage import make_storage
from services.api.eas_api.config import get_settings
from services.api.eas_api.courses import router as courses_router
from services.api.eas_api.documents import router as documents_router
from services.api.eas_api.learning import router as learning_router
from services.api.eas_api.retrieval import router as retrieval_router
from services.api.eas_api.schemas import router as schemas_router
from services.api.eas_api.security import InMemoryRateLimiter
from services.api.eas_api.turns import router as turns_router
from services.api.eas_api.visualizations import router as visualizations_router


async def _shared_rate_limit(request: Request, keys: list[str]) -> int | None:
    """Atomically consume one fixed-window token per key in the shared SQL database."""
    engine = request.app.state.db_engine
    dialect = engine.dialect.name
    if dialect not in {"postgresql", "sqlite"}:
        return None
    now = datetime.now(UTC)
    window = request.app.state.settings.rate_limit_window_seconds
    factory = make_session_factory(engine)
    retry_after = None
    async with factory() as db:
        async with db.begin():
            for key in keys:
                insert = pg_insert if dialect == "postgresql" else sqlite_insert
                statement = insert(RateLimitBucket).values(
                    key=key,
                    window_started_at=now,
                    request_count=1,
                    updated_at=now,
                )
                expired = RateLimitBucket.window_started_at <= now.timestamp() - window
                # SQLite may return a naive datetime; timestamps are normalized below.
                from sqlalchemy import func

                stored_epoch = func.strftime(
                    "%s", RateLimitBucket.window_started_at
                ) if dialect == "sqlite" else func.extract(
                    "epoch", RateLimitBucket.window_started_at
                )
                expired = stored_epoch <= now.timestamp() - window
                statement = statement.on_conflict_do_update(
                    index_elements=[RateLimitBucket.key],
                    set_={
                        "window_started_at": case(
                            (expired, now), else_=RateLimitBucket.window_started_at
                        ),
                        "request_count": case(
                            (expired, 1), else_=RateLimitBucket.request_count + 1
                        ),
                        "updated_at": now,
                    },
                ).returning(RateLimitBucket.request_count, RateLimitBucket.window_started_at)
                count, started_at = (await db.execute(statement)).one()
                if count > request.app.state.settings.rate_limit_requests:
                    epoch = (
                        started_at.timestamp()
                        if started_at.tzinfo
                        else started_at.replace(tzinfo=UTC).timestamp()
                    )
                    remaining = max(1, int(window - (now.timestamp() - epoch)))
                    retry_after = max(retry_after or 0, remaining)
            if uuid4().int % 128 == 0:
                await db.execute(
                    delete(RateLimitBucket).where(
                        RateLimitBucket.updated_at
                        < now - timedelta(seconds=max(3600, window * 2))
                    )
                )
    return retry_after


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    engine = make_engine(settings.database_url.get_secret_value(), echo=settings.sql_echo)
    app.state.db_engine = engine
    app.state.settings = settings
    app.state.llm_provider = OpenAICompatibleLLM(settings)
    if settings.otel_exporter_otlp_endpoint:
        provider = TracerProvider(
            resource=Resource.create({"service.name": settings.otel_service_name})
        )
        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=settings.otel_exporter_otlp_endpoint))
        )
        trace.set_tracer_provider(provider)
        app.state.otel_provider = provider
    app.state.rate_limiter = InMemoryRateLimiter(
        settings.rate_limit_requests,
        settings.rate_limit_window_seconds,
        settings.rate_limit_max_clients,
    )
    if settings.environment != "development" and settings.storage_backend != "s3":
        raise RuntimeError("Non-development deployments must use persistent S3-compatible storage")
    app.state.storage = make_storage(
        settings.storage_backend,
        settings.storage_root,
        settings.s3_bucket,
        settings.aws_region,
        settings.s3_endpoint_url,
    )
    if settings.environment == "development":
        async with engine.begin() as connection:
            if engine.dialect.name == "postgresql" and os.getenv(
                "EAS_PGVECTOR_ENABLED", "false"
            ).lower() in {"1", "true", "yes"}:
                await connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await connection.run_sync(Base.metadata.create_all)
    try:
        yield
    finally:
        await engine.dispose()
        provider = getattr(app.state, "otel_provider", None)
        if provider is not None:
            provider.shutdown()


app = FastAPI(title="EAS API", version="0.1.0", lifespan=lifespan)
logger = logging.getLogger("eas.api")
app.include_router(documents_router)
app.include_router(retrieval_router)
app.include_router(learning_router)
app.include_router(courses_router)
app.include_router(turns_router)
app.include_router(schemas_router)
app.include_router(visualizations_router)


@app.exception_handler(HTTPException)
async def http_error_handler(request: Request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail if isinstance(exc.detail, dict) else {}
    error = ApiError(
        code=detail.get("code", "REQUEST_FAILED"),
        message=detail.get("message", str(exc.detail)),
        details=detail.get("details", {}),
        retryable=detail.get("retryable", False),
        request_id=getattr(request.state, "request_id", None),
    )
    return JSONResponse(status_code=exc.status_code, content=error.model_dump())


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    fields = [
        {"location": [str(part) for part in error.get("loc", ())], "type": error.get("type")}
        for error in exc.errors()
    ]
    error = ApiError(
        code="INVALID_REQUEST",
        message="One or more request fields are invalid.",
        details={"fields": fields},
        request_id=getattr(request.state, "request_id", None),
    )
    return JSONResponse(status_code=422, content=error.model_dump())


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    # Accept only UUID request IDs to keep log fields bounded and newline-safe.
    try:
        request_id = str(uuid4()) if not request.headers.get("x-request-id") else str(
            UUID(request.headers["x-request-id"])
        )
    except ValueError:
        request_id = str(uuid4())
    request.state.request_id = request_id
    started = time.perf_counter()
    if request.url.path.startswith("/v1/") and request.url.path not in {
        "/v1/health",
        "/v1/readiness",
    }:
        settings = getattr(request.app.state, "settings", None) or get_settings()
        limiter = getattr(request.app.state, "rate_limiter", None)
        if limiter is None:
            limiter = InMemoryRateLimiter(
                settings.rate_limit_requests,
                settings.rate_limit_window_seconds,
                settings.rate_limit_max_clients,
            )
            request.app.state.rate_limiter = limiter
        client_ip = request.client.host if request.client else "unknown"
        try:
            session_key = str(UUID(request.cookies.get("eas_session", "")))
        except ValueError:
            session_key = None
        keys = [f"ip:{client_ip}"]
        if session_key:
            keys.append(f"session:{session_key}")
        retry_after = await _shared_rate_limit(request, keys)
        if retry_after is None:
            now = time.monotonic()
            retry_values = [limiter.retry_after(key, now) for key in keys]
            retry_after = max((value for value in retry_values if value is not None), default=None)
        if retry_after is not None:
            error = ApiError(
                code="RATE_LIMITED",
                message="Too many requests. Please wait before trying again.",
                details={"retry_after_seconds": retry_after},
                retryable=True,
                request_id=request_id,
            )
            response = JSONResponse(
                status_code=429,
                content=error.model_dump(),
                headers={"Retry-After": str(retry_after), "X-Request-ID": request_id},
            )
            logger.info(
                "request.rate_limited",
                extra={
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                },
            )
            return response
    try:
        parent_context = extract(dict(request.headers))
        token = attach(parent_context)
        try:
            with trace.get_tracer("eas.api").start_as_current_span("http.server.request") as span:
                span.set_attribute("http.request.method", request.method)
                span.set_attribute("url.path", request.url.path)
                span.set_attribute("eas.request_id", request_id)
                response = await call_next(request)
                span.set_attribute("http.response.status_code", response.status_code)
        finally:
            detach(token)
    except Exception:
        raise
    response.headers["x-request-id"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.method == "GET" and (
        request.url.path in {"/", "/learn", "/learn/", "/chat", "/chat/"}
    ) and response.headers.get("content-type", "").startswith("text/html"):
        # Next's static App Router output uses inline bootstrap/RSC scripts. Give
        # those scripts a per-response nonce while leaving API responses on
        # the strict self-only policy below.
        nonce = secrets.token_urlsafe(18)
        body = b"".join([chunk async for chunk in response.body_iterator])
        script_tag = re.compile(br"<script\b(?![^>]*\bsrc\s*=)([^>]*)>", re.IGNORECASE)
        body = script_tag.sub(
            lambda match: b"<script" + match.group(1) + b' nonce="' + nonce.encode("ascii") + b'">',
            body,
        )
        headers = dict(response.headers)
        headers.pop("content-length", None)
        headers.pop("content-encoding", None)
        response = Response(
            content=body,
            status_code=response.status_code,
            headers=headers,
            background=response.background,
        )
        response.headers["Content-Security-Policy"] = (
            f"default-src 'self'; script-src 'self' 'nonce-{nonce}'; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
            "connect-src 'self'; object-src 'none'; "
            "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
        )
    else:
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
            "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
        )
    try:
        session_id = str(UUID(request.cookies.get("eas_session", "")))
    except ValueError:
        session_id = None
    logger.info(
        "request.completed",
        extra={
            "request_id": request_id,
            "session_id": session_id,
            "method": request.method,
            "path": request.url.path,
            "status_code": response.status_code,
            "latency_ms": round((time.perf_counter() - started) * 1000, 2),
        },
    )
    return response


@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, exc: Exception) -> JSONResponse:
    # Keep implementation details out of public error responses.
    logger.error(
        "request.unhandled_error",
        extra={
            "request_id": getattr(request.state, "request_id", None),
            "exception_type": type(exc).__name__,
        },
    )
    error = ApiError(
        code="INTERNAL_ERROR",
        message="The request could not be completed.",
        retryable=True,
        request_id=getattr(request.state, "request_id", None),
    )
    return JSONResponse(status_code=500, content=error.model_dump())


@app.get("/v1/health", response_model=HealthResponse)
@app.get("/health", response_model=HealthResponse, include_in_schema=False)
async def health() -> HealthResponse:
    settings = get_settings()
    return HealthResponse(status="ok", service=settings.app_name, environment=settings.environment)


@app.get("/v1/readiness", response_model=ReadinessResponse)
@app.get("/readiness", response_model=ReadinessResponse, include_in_schema=False)
async def readiness(request: Request) -> JSONResponse:
    database_ok = False
    try:
        database_ok = await check_database(request.app.state.db_engine)
    except Exception:
        database_ok = False
    result = ReadinessResponse(
        status="ready" if database_ok else "not_ready",
        checks={"database": "ok" if database_ok else "failed"},
        checked_at=datetime.now(UTC),
    )
    return JSONResponse(
        status_code=200 if database_ok else 503,
        content=result.model_dump(mode="json"),
    )


_repository_root = Path(__file__).resolve().parents[3]
_default_web_directory = _repository_root / "apps" / "web"
_configured_web_directory = os.environ.get("EAS_WEB_DIR", "").strip()
_web_directory = (
    Path(_configured_web_directory).resolve()
    if _configured_web_directory
    else _default_web_directory
)
if _configured_web_directory:
    try:
        _web_directory.relative_to((_repository_root / "apps").resolve())
    except ValueError as exc:
        raise RuntimeError("EAS_WEB_DIR must point to a directory inside the apps folder") from exc
    if not _web_directory.is_dir():
        raise RuntimeError("EAS_WEB_DIR does not point to an existing directory")
if _web_directory.is_dir():
    app.mount("/", StaticFiles(directory=_web_directory, html=True), name="web")

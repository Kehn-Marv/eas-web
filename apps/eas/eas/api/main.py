import asyncio
from contextlib import asynccontextmanager
import logging
import sys

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse

from eas.logging import configure_logging
from eas.services.config import (
    ensure_runtime_settings_files,
    export_runtime_settings_to_env,
    load_auth_settings,
    load_system_settings,
)
from eas.services.config.origins import normalize_origins
from eas.services.path_service import get_path_service

ensure_runtime_settings_files()
export_runtime_settings_to_env(overwrite=True)
configure_logging()
logger = logging.getLogger(__name__)


class _SuppressWsNoise(logging.Filter):
    """Suppress noisy uvicorn logs for WebSocket connection churn."""

    _SUPPRESSED = ("connection open", "connection closed")

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(f in msg for f in self._SUPPRESSED)


logging.getLogger("uvicorn.error").addFilter(_SuppressWsNoise())

CONFIG_DRIFT_ERROR_TEMPLATE = (
    "Configuration Drift Detected: Capability tool references {drift} are not "
    "registered in the runtime tool registry. Register the missing tools or "
    "remove the stale tool names from the capability manifests."
)


def validate_tool_consistency():
    """
    Validate that capability manifests only reference tools that are actually
    registered in the runtime ``ToolRegistry``.
    """
    try:
        from eas.runtime.registry.capability_registry import get_capability_registry
        from eas.runtime.registry.tool_registry import get_tool_registry

        capability_registry = get_capability_registry()
        tool_registry = get_tool_registry()
        available_tools = set(tool_registry.list_tools())

        referenced_tools = set()
        for manifest in capability_registry.get_manifests():
            referenced_tools.update(manifest.get("tools_used", []) or [])

        drift = referenced_tools - available_tools
        if drift:
            raise RuntimeError(CONFIG_DRIFT_ERROR_TEMPLATE.format(drift=drift))
    except RuntimeError:
        logger.exception("Configuration validation failed")
        raise
    except Exception:
        logger.exception("Failed to load configuration for validation")
        raise


def _build_cors_settings() -> dict[str, object]:
    """Build CORS settings for both localhost and remote Docker deployments."""
    system_settings = load_system_settings()
    auth_settings = load_auth_settings()
    frontend_port = str(system_settings["frontend_port"])
    extra_origins = normalize_origins(
        [system_settings["cors_origin"], system_settings["cors_origins"]]
    )
    origins = [
        f"http://localhost:{frontend_port}",
        f"http://127.0.0.1:{frontend_port}",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]
    for origin in extra_origins:
        if origin not in origins:
            origins.append(origin)

    # Auth is disabled by default. In that local/single-user mode, mirror the
    # pre-v1.3.8 behavior and allow remote Docker/LAN origins out of the box.
    # When auth is enabled, require explicit CORS_ORIGIN(S) for credentialed
    # cross-origin requests.
    allow_origin_regex = None if auth_settings["enabled"] else r"https?://.*"
    mode = "explicit" if auth_settings["enabled"] else "permissive"
    return {
        "allow_origins": origins,
        "allow_origin_regex": allow_origin_regex,
        "mode": mode,
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifecycle management
    Gracefully handle startup and shutdown events, avoid CancelledError
    """
    # Execute on startup
    logger.info("Application startup")
    app.state.ready = False

    # Validate configuration consistency
    validate_tool_consistency()

    # Build one process-level dependency graph.  Every adapter resolves turns
    # through this container, so a WebSocket cannot accidentally construct a
    # second store/runtime for the same authenticated scope.
    from eas.app.container import get_application_container

    application_container = getattr(app.state, "application_container", None)
    if application_container is None:
        application_container = get_application_container()
        app.state.application_container = application_container
    await application_container.start()
    from eas.api.utils.progress_broadcaster import ProgressBroadcaster
    from eas.api.utils.task_log_stream import get_task_stream_manager
    from eas.knowledge.progress_events import install_progress_ports

    install_progress_ports(
        broadcast=ProgressBroadcaster.get_instance().broadcast,
        emit_task_event=get_task_stream_manager().emit,
    )
    migration_reports = await application_container.run_startup_data_migrations()
    legacy_reports = migration_reports["legacy_chat"]
    migrated_reports = [report for report in legacy_reports if report.get("source_hash")]
    if migrated_reports:
        logger.info(
            "Legacy chat migration complete: imported=%s skipped=%s archived=%s",
            sum(int(report.get("imported") or 0) for report in migrated_reports),
            sum(int(report.get("skipped") or 0) for report in migrated_reports),
            [report.get("archived_to", "") for report in migrated_reports],
        )
    workspace_migrated = sum(
        int(report.get("migrated") or 0) for report in migration_reports["workspace_preferences"]
    )
    if workspace_migrated:
        logger.info(
            "Workspace session migration complete: migrated=%s scopes=%s",
            workspace_migrated,
            len(migration_reports["workspace_preferences"]),
        )

    try:
        from eas.learning.assessment import reconcile_linked_assessments

        recovered, failed = await reconcile_linked_assessments()
        if recovered or failed:
            logger.info("Linked assessment recovery: recovered=%s failed=%s", recovered, failed)
    except Exception:
        logger.exception("Failed to reconcile linked assessments at startup")

    # Initialize LLM client early so OPENAI_* env vars are available before
    # any downstream provider integrations start.
    try:
        from eas.services.llm import get_llm_client

        llm_client = get_llm_client()
        logger.info(f"LLM client initialized: model={llm_client.config.model}")
    except Exception as e:
        logger.warning(f"Failed to initialize LLM client at startup: {e}")

    try:
        from eas.events.event_bus import get_event_bus

        event_bus = get_event_bus()
        await event_bus.start()
        logger.info("EventBus started")
    except Exception as e:
        logger.warning(f"Failed to start EventBus: {e}")

    async def _start_cron() -> None:
        from eas.services.cron import get_cron_service

        await get_cron_service().start()

    async def _stop_cron() -> None:
        from eas.services.cron import get_cron_service

        await get_cron_service().stop()

    async def _start_web_source_sync() -> None:
        from eas.services.web_source.scheduler import (
            start_web_source_sync_scheduler,
        )

        await start_web_source_sync_scheduler()

    async def _stop_web_source_sync() -> None:
        from eas.services.web_source.scheduler import (
            stop_web_source_sync_scheduler,
        )

        await stop_web_source_sync_scheduler()

    from eas.runtime.coordination import BackgroundCommandKind

    async def _handle_background_command(command) -> None:
        kind = str(command.kind)
        if kind == BackgroundCommandKind.CRON_RELOAD:
            from eas.services.cron import get_cron_service

            get_cron_service().reload()
            return
        raise ValueError(f"Unknown background command kind: {kind}")

    cron_service = None
    try:
        from eas.services.cron import get_cron_service

        cron_service = get_cron_service()
        loop = asyncio.get_running_loop()

        def _notify_cron_change() -> None:
            task = loop.create_task(
                application_container.coordinator.submit_background_command(
                    BackgroundCommandKind.CRON_RELOAD
                )
            )
            task.add_done_callback(
                lambda completed: completed.exception() if not completed.cancelled() else None
            )

        cron_service.change_notifier = _notify_cron_change
    except Exception:
        logger.exception("Failed to configure cron change notifications")

    from eas.runtime.background_leader import BackgroundLeaderSupervisor

    background_supervisor = BackgroundLeaderSupervisor(
        application_container.coordinator,
        application_container.worker_id,
        start_callbacks=[
            _start_cron,
            _start_web_source_sync,
        ],
        stop_callbacks=[
            _stop_cron,
            _stop_web_source_sync,
        ],
        recovery_callback=application_container.recover_once,
        control_callback=_handle_background_command,
        renew_interval_seconds=application_container.settings.renew_interval_seconds,
        recovery_interval_seconds=application_container.settings.recovery_interval_seconds,
    )
    app.state.background_supervisor = background_supervisor
    await background_supervisor.start()

    # Ping PocketBase if configured — logs a warning (not an error) if unreachable
    try:
        from eas.services.pocketbase_client import ping_pocketbase

        await ping_pocketbase()
    except Exception as e:
        logger.warning(f"PocketBase startup check failed: {e}")

    # Migrate any v1 memory files (PROFILE.md / SOUL.md / SUMMARY.md) into a
    # backup folder so the v2 three-layer subsystem starts clean.
    try:
        from eas.services.memory import (
            migrate_v1_if_needed,
        )
        from eas.services.path_service import get_path_service

        get_path_service().migrate_legacy_memory_markdown()
        backup = migrate_v1_if_needed()
        if backup is not None:
            logger.info("v1 memory archived to %s", backup)
    except Exception as e:
        logger.warning(f"v1 memory migration failed: {e}")

    # Run local, non-network diagnostics on every process start. This catches
    # missing configuration/storage prerequisites early without blocking the
    # API from serving health or setup routes.
    try:
        from eas.services.doctor import run_diagnostics

        report = await run_diagnostics(online=False)
        for check in report.checks:
            if check.status == "fail":
                logger.warning("Startup diagnostic failed (%s): %s", check.key, check.detail)
        logger.info(
            "Startup diagnostics complete: ok=%s checks=%s",
            report.ok,
            len(report.checks),
        )
    except Exception:
        logger.exception("Startup diagnostics could not complete")

    app.state.ready = True
    yield

    # Execute on shutdown
    app.state.ready = False
    logger.info("Application shutdown")

    install_progress_ports(broadcast=None, emit_task_event=None)

    try:
        await background_supervisor.close()
        logger.info("Leader-owned background services stopped")
    except Exception as e:
        logger.warning(f"Failed to stop background leader: {e}")

    try:
        await application_container.close()
        logger.info("Application container closed")
    except Exception as e:
        logger.warning(f"Failed to close application container: {e}")

    # Close pooled LLM SDK clients so their keep-alive sockets and transports
    # are released deterministically instead of waiting for interpreter GC.
    try:
        from eas.services.llm.provider_factory import close_runtime_provider_pool

        await close_runtime_provider_pool()
        logger.info("LLM provider pool closed")
    except Exception as e:
        logger.warning(f"Failed to close LLM provider pool: {e}")

    try:
        from eas.runtime.agentic.client import close_agentic_client_pool

        await close_agentic_client_pool()
        logger.info("Agentic LLM client pool closed")
    except Exception as e:
        logger.warning(f"Failed to close agentic LLM client pool: {e}")

    # Stop EventBus
    try:
        from eas.events.event_bus import get_event_bus

        event_bus = get_event_bus()
        await event_bus.stop()
        logger.info("EventBus stopped")
    except Exception as e:
        logger.warning(f"Failed to stop EventBus: {e}")


from eas.services.workspace.activity import WorkspaceActivityMiddleware

app = FastAPI(
    title="EAS API",
    version="1.0.0",
    lifespan=lifespan,
    # Disable automatic trailing slash redirects to prevent protocol downgrade issues
    # when deployed behind HTTPS reverse proxies (e.g., nginx).
    # Without this, FastAPI's 307 redirects may change HTTPS to HTTP.
    # See: https://github.com/eas-learning/eas/issues/112
    redirect_slashes=False,
)
app.add_middleware(WorkspaceActivityMiddleware)


@app.middleware("http")
async def json_error_boundary(request: Request, call_next):
    """Catch-all so 500s always return JSON, never Starlette's plain-text body.

    Registered as a middleware rather than an ``@app.exception_handler``: a
    handler for ``Exception`` is installed on Starlette's outermost
    ``ServerErrorMiddleware``, so its response skips every middleware added
    here — the 500 would carry no CORS headers (a cross-origin caller sees an
    opaque CORS failure instead of this body) and would never reach the access
    log below. Registered *before* ``CORSMiddleware``, this boundary sits
    inside it, so the response travels back out through the normal stack.
    """
    try:
        return await call_next(request)
    except Exception as exc:
        logger.error(
            "Unhandled exception on %s %s: %s",
            request.method,
            request.url.path,
            exc,
            exc_info=True,
        )
        return JSONResponse(
            status_code=500,
            content={
                "detail": f"{type(exc).__name__}: {exc}",
                "type": type(exc).__name__,
            },
        )


# Access logging is funneled through this one middleware. uvicorn's own
# per-request access log is disabled on every launch path (run_server.py via
# access_log=False; the launcher and Docker via `--no-access-log`), so routine
# 200s — the chatty frontend polling of /settings, /tools, /knowledge-bases,
# etc. — never reach the logs. Only non-200s are surfaced, since those are the
# ones worth seeing.
#
# The `eas.access` logger gets its own INFO stdout handler rather than
# leaning on the root handlers: the root console handler runs at the global log
# level (WARNING by default), which would swallow these INFO access lines.
# propagate=False keeps them from also printing through root if the global
# level is ever lowered to INFO/DEBUG.
_access_logger = logging.getLogger("eas.access")
if not any(getattr(h, "_eas_access_handler", False) for h in _access_logger.handlers):
    _access_handler = logging.StreamHandler(sys.stdout)
    _access_handler.setLevel(logging.INFO)
    _access_handler.setFormatter(logging.Formatter("%(message)s"))
    _access_handler._eas_access_handler = True  # type: ignore[attr-defined]
    _access_logger.addHandler(_access_handler)
    _access_logger.setLevel(logging.INFO)
    _access_logger.propagate = False


@app.middleware("http")
async def selective_access_log(request, call_next):
    response = await call_next(request)
    if response.status_code != 200:
        _access_logger.info(
            '%s - "%s %s HTTP/%s" %d',
            request.client.host if request.client else "-",
            request.method,
            request.url.path,
            request.scope.get("http_version", "1.1"),
            response.status_code,
        )
    return response


_cors_settings = _build_cors_settings()
logger.info(
    "CORS configured: mode=%s allow_origins=%s allow_origin_regex=%s",
    _cors_settings["mode"],
    _cors_settings["allow_origins"],
    _cors_settings["allow_origin_regex"],
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_settings["allow_origins"],
    allow_origin_regex=_cors_settings["allow_origin_regex"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize user directories on startup
try:
    from eas.services.setup import init_user_directories

    init_user_directories()
except Exception:
    # Fallback: just create the main directory if it doesn't exist
    user_dir = get_path_service().get_public_outputs_root()
    if not user_dir.exists():
        user_dir.mkdir(parents=True)

# Import routers only after runtime settings are initialized.
# Some router modules load YAML settings at import time.
from eas.api.routers import (
    attachments,
    auth,
    capabilities,
    courses,
    dashboard,
    file_preview,
    imports,
    knowledge,
    learning_journal,
    mastery_path,
    memory,
    notebook,
    outputs,
    personas,
    practice,
    question,
    question_notebook,
    quiz_judge,
    reading,
    reading_extensions,
    sessions,
    skills,
    settings,
    system,
    unified_ws,
    visualizers,
    voice,
    workspace,
)
from eas.api.routers import (
    tools as tools_router,
)
from eas.api.routers.file_library import router as file_library_router  # noqa: E402

# Auth router is public — login/logout/register/status require no token
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(outputs.router, prefix="/files/outputs", tags=["outputs"])
app.include_router(
    workspace.files_router,
    prefix="/files/workspace-items",
    tags=["workspace"],
)

# All other routers require a valid session when AUTH_ENABLED=true.
# require_auth is a no-op when AUTH_ENABLED=false, so this is safe for local use.
from eas.api.routers.auth import (  # noqa: E402
    require_admin,
    require_auth,
    require_learning_surface,
)

_auth = [Depends(require_learning_surface)]
_admin = [Depends(require_admin)]

app.include_router(question.router, prefix="/api/question", tags=["question"], dependencies=_auth)
app.include_router(knowledge.router, prefix="/api", tags=["knowledge-bases"], dependencies=_auth)
app.include_router(
    file_preview.router,
    prefix="/api/file-preview",
    tags=["file-preview"],
    dependencies=[Depends(require_auth)],
)
app.include_router(imports.router, prefix="/api/imports", tags=["imports"], dependencies=_auth)
app.include_router(
    dashboard.router, prefix="/api/dashboard", tags=["dashboard"], dependencies=_auth
)
app.include_router(
    mastery_path.router,
    prefix="/api/mastery-paths",
    tags=["mastery-path"],
    dependencies=_auth,
)
app.include_router(
    file_library_router,
    prefix="/files/library",
    tags=["library"],
    dependencies=_auth,
)
# WebSocket handlers authenticate inside the connection before ``accept``.
# Keep them off HTTP router dependencies: ``require_learning_surface`` takes a
# Request, which FastAPI cannot construct for a WebSocket scope.
app.include_router(question.ws_router, prefix="/ws/questions", tags=["question"])
app.include_router(knowledge.ws_router, prefix="/ws", tags=["knowledge-bases"])
app.include_router(
    mastery_path.ws_router,
    prefix="/ws",
    tags=["mastery-path"],
)
app.include_router(notebook.router, prefix="/api", tags=["notebooks"], dependencies=_auth)
app.include_router(reading.router, prefix="/api/reading", tags=["reading"], dependencies=_auth)
app.include_router(
    reading_extensions.router,
    prefix="/api/reading",
    tags=["reading-extensions"],
    dependencies=_auth,
)
app.include_router(memory.router, prefix="/api/memory", tags=["memory"], dependencies=_auth)
app.include_router(
    learning_journal.router,
    prefix="/api/learning-journal",
    tags=["learning-journal"],
    dependencies=_auth,
)
app.include_router(
    capabilities.router,
    prefix="/api/capabilities",
    tags=["capabilities"],
    dependencies=_auth,
)
app.include_router(sessions.router, prefix="/api/sessions", tags=["sessions"], dependencies=_auth)
app.include_router(courses.router, prefix="/api/courses", tags=["courses"], dependencies=_auth)
app.include_router(
    question_notebook.router,
    prefix="/api/question-notebook",
    tags=["question-notebook"],
    dependencies=_auth,
)
app.include_router(
    practice.router,
    prefix="/api/question-notebook/practice",
    tags=["practice"],
    dependencies=_auth,
)
# Public UI-settings read (auth pages bootstrap the interface language
# before a session exists, so GET /api/settings/ui must not be gated
# by _auth). Mounted first so the path resolves here, not on the gated
# settings router below.
app.include_router(
    settings.public_router,
    prefix="/api/settings",
    tags=["settings"],
)
app.include_router(settings.router, prefix="/api/settings", tags=["settings"], dependencies=_auth)
app.include_router(skills.router, prefix="/api/skills", tags=["skills"], dependencies=_auth)
app.include_router(
    workspace.settings_router,
    prefix="/api/settings/workspace",
    tags=["workspace-settings"],
    dependencies=_auth,
)
app.include_router(personas.router, prefix="/api", tags=["personas"], dependencies=_auth)
app.include_router(tools_router.router, prefix="/api/tools", tags=["tools"], dependencies=_auth)
app.include_router(system.router, prefix="/api/system", tags=["system"], dependencies=_auth)
app.include_router(voice.router, prefix="/api/voice", tags=["voice"], dependencies=_auth)
app.include_router(
    visualizers.router,
    prefix="/api/visualizers",
    tags=["visualizers"],
    dependencies=_auth,
)
app.include_router(
    attachments.router,
    prefix="/files/attachments",
    tags=["attachments"],
    dependencies=_auth,
)

# Unified WebSocket endpoint — auth is checked inside the handler (WebSockets
# cannot use FastAPI dependencies in the standard way)
app.include_router(unified_ws.router, tags=["unified-ws"])

# Quiz AI-judge WebSocket — same caveat as unified_ws above; auth is checked
# inside the handler so the WS upgrade isn't rejected by an HTTP-style dep.
app.include_router(quiz_judge.router, prefix="/ws", tags=["quiz-judge"])


@app.get("/")
async def root():
    return {"message": "Welcome to EAS API"}


@app.get("/health/live")
async def health_live():
    return {"status": "alive"}


@app.get("/health/ready")
async def health_ready(request: Request):
    if not bool(getattr(request.app.state, "ready", False)):
        return JSONResponse(status_code=503, content={"status": "not_ready"})
    container = getattr(request.app.state, "application_container", None)
    if container is None or not await container.coordinator.health():
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "reason": "coordination_unavailable"},
        )
    return {"status": "ready"}


if __name__ == "__main__":
    from eas.api.run_server import main as run_server_main

    run_server_main()

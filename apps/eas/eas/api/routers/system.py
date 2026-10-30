"""
System Status API Router
Manages system status checks and model connection tests
"""

import time

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from eas.api.contracts.turn_protocol import (
    MINIMUM_WEB_PROTOCOL_VERSION,
    PROTOCOL_VERSION,
    RuntimeStatus,
)
from eas.api.routers.auth import require_admin
from eas.services.config import (
    resolve_search_runtime_config,
    supported_search_providers_hint,
)


def get_embedding_client(*args, **kwargs):
    from eas.services.embedding.client import get_embedding_client as resolve

    return resolve(*args, **kwargs)


def get_embedding_config(*args, **kwargs):
    from eas.services.embedding.config import get_embedding_config as resolve

    return resolve(*args, **kwargs)


def get_llm_config(*args, **kwargs):
    from eas.services.llm.config import get_llm_config as resolve

    return resolve(*args, **kwargs)


def get_token_limit_kwargs(*args, **kwargs):
    from eas.services.llm.config import get_token_limit_kwargs as resolve

    return resolve(*args, **kwargs)


async def llm_complete(*args, **kwargs):
    from eas.services.llm import complete

    return await complete(*args, **kwargs)


def web_search(*args, **kwargs):
    from eas.services.search import web_search as search

    return search(*args, **kwargs)


router = APIRouter()


class TestResponse(BaseModel):
    success: bool
    message: str
    model: str | None = None
    response_time_ms: float | None = None
    error: str | None = None


@router.get(
    "/runtime",
    dependencies=[Depends(require_admin)],
    response_model=RuntimeStatus,
)
async def get_runtime_status(request: Request) -> RuntimeStatus:
    """Return credential-free coordination and worker diagnostics."""

    from eas.app.container import get_application_container

    container = getattr(request.app.state, "application_container", None)
    if container is None:
        container = get_application_container()
        await container.start()
    report = await container.runtime_report()
    return RuntimeStatus.model_validate(
        {
            **report,
            "leader_healthy": bool(report.get("leader_id")),
            "protocol_version": PROTOCOL_VERSION,
            "minimum_web_protocol_version": MINIMUM_WEB_PROTOCOL_VERSION,
        }
    )


@router.post("/test/llm", response_model=TestResponse)
async def test_llm_connection():
    """
    Test LLM model connection by sending a simple completion request

    Returns:
        Test result with success status and response time
    """
    start_time = time.time()

    try:
        llm_config = get_llm_config()
        model = llm_config.model
        base_url = llm_config.base_url.rstrip("/")

        # Sanitize Base URL (remove /chat/completions suffix if present)
        for suffix in ["/chat/completions", "/completions"]:
            if base_url.endswith(suffix):
                base_url = base_url[: -len(suffix)]

        # Handle API Key (inject dummy if missing for local LLMs)
        api_key = llm_config.api_key
        if not api_key:
            api_key = "sk-no-key-required"

        # Send a minimal test request with a prompt that guarantees output
        test_prompt = "Say 'OK' to confirm you are working. Do not produce long output."
        token_kwargs = get_token_limit_kwargs(model, max_tokens=200)

        response = await llm_complete(
            model=model,
            prompt=test_prompt,
            system_prompt="You are a helpful assistant. Respond briefly.",
            binding=llm_config.binding,
            api_key=api_key,
            base_url=base_url,
            temperature=0.1,
            **token_kwargs,
        )

        response_time = (time.time() - start_time) * 1000

        if response and len(response.strip()) > 0:
            return TestResponse(
                success=True,
                message="LLM connection successful",
                model=model,
                response_time_ms=round(response_time, 2),
            )
        return TestResponse(
            success=False,
            message="LLM connection failed: Empty response",
            model=model,
            error="Empty response from API",
        )

    except ValueError as e:
        return TestResponse(success=False, message=f"LLM configuration error: {e!s}", error=str(e))
    except Exception as e:
        response_time = (time.time() - start_time) * 1000
        return TestResponse(
            success=False,
            message=f"LLM connection failed: {e!s}",
            response_time_ms=round(response_time, 2),
            error=str(e),
        )


@router.post("/test/embeddings", response_model=TestResponse)
async def test_embeddings_connection():
    """
    Test Embeddings model connection by sending a simple embedding request

    Returns:
        Test result with success status and response time
    """
    start_time = time.time()

    try:
        embedding_config = get_embedding_config()
        embedding_client = get_embedding_client()

        model = embedding_config.model
        binding = embedding_config.binding

        # Probe a tiny batch so "connection OK" also exercises the path RAG
        # uses for multi-chunk indexing.
        test_texts = ["test", "retrieval batch probe"]
        embeddings = await embedding_client.embed(test_texts)

        response_time = (time.time() - start_time) * 1000

        if (
            embeddings is not None
            and len(embeddings) == len(test_texts)
            and all(len(vector) > 0 for vector in embeddings)
            and len({len(vector) for vector in embeddings}) == 1
        ):
            return TestResponse(
                success=True,
                message=f"Embeddings connection successful ({binding} provider)",
                model=model,
                response_time_ms=round(response_time, 2),
            )
        return TestResponse(
            success=False,
            message="Embeddings connection failed: Invalid response",
            model=model,
            error="Embedding response must contain one non-empty vector per input",
        )

    except ValueError as e:
        return TestResponse(
            success=False, message=f"Embeddings configuration error: {e!s}", error=str(e)
        )
    except Exception as e:
        response_time = (time.time() - start_time) * 1000
        return TestResponse(
            success=False,
            message=f"Embeddings connection failed: {e!s}",
            response_time_ms=round(response_time, 2),
            error=str(e),
        )


@router.post("/test/search", response_model=TestResponse)
async def test_search_connection():
    start_time = time.time()

    try:
        search_config = resolve_search_runtime_config()
        if search_config.provider == "none":
            return TestResponse(
                success=False,
                message="Search is disabled",
                error="Set a Search provider in Settings > Catalog.",
            )
        if search_config.unsupported_provider:
            return TestResponse(
                success=False,
                message=(
                    f"Search provider `{search_config.requested_provider}` is deprecated/unsupported."
                ),
                error=f"Switch to {supported_search_providers_hint()}",
            )
        if search_config.missing_credentials:
            return TestResponse(
                success=False,
                message=f"Search provider `{search_config.requested_provider}` missing credentials.",
                error="Set profile.api_key in Settings > Catalog.",
            )
        result = web_search("EAS health check", provider=search_config.provider)
        response_time = (time.time() - start_time) * 1000
        answer = result.get("answer") or result.get("search_results")
        if not answer:
            raise ValueError("Search provider returned no content")
        return TestResponse(
            success=True,
            message="Search connection successful",
            model=search_config.provider,
            response_time_ms=round(response_time, 2),
        )

    except ValueError as e:
        return TestResponse(
            success=False, message=f"Search configuration error: {e!s}", error=str(e)
        )
    except Exception as e:
        response_time = (time.time() - start_time) * 1000
        return TestResponse(
            success=False,
            message=f"Search connection check failed: {e!s}",
            response_time_ms=round(response_time, 2),
            error=str(e),
        )

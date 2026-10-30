"""Request-scoped delivery of generated output artifacts."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse

from eas.api.routers.auth import require_auth
from eas.multi_user.context import get_current_user_or_none
from eas.multi_user.paths import get_current_path_service, get_path_service_for_scope
from eas.services.auth import TokenPayload
from eas.services.path_service import PathService

router = APIRouter()


def _request_path_service() -> PathService:
    """Resolve the workspace installed by ``require_auth`` without fallback.

    The general-purpose ``get_path_service()`` retains a compatibility fallback
    to the local admin workspace for non-request callers.  A download endpoint
    must fail closed instead: otherwise an authentication/context regression
    could expose an administrator artifact to an ordinary request.
    """
    user = get_current_user_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Output not found")
    return get_current_path_service()


def _resolve_output(path_service: PathService, relative_path: str) -> Path:
    output_path = path_service.resolve_public_output_path(relative_path)
    if output_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Output not found")
    return output_path


@router.get("/{output_path:path}", operation_id="read_output_get")
@router.head("/{output_path:path}", operation_id="read_output_head")
async def read_output(
    output_path: str,
    _auth: TokenPayload | None = Depends(require_auth),
) -> FileResponse:
    """Serve one allowlisted artifact from the authenticated user's reach."""
    path = _resolve_output(_request_path_service(), output_path)
    return FileResponse(path)

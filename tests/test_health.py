from fastapi.testclient import TestClient

from services.api.eas_api import main as api_main
from services.api.eas_api.config import Settings
from services.api.eas_api.main import app


def test_health_contract():
    with TestClient(app) as client:
        response = client.get("/v1/health")
        ui = client.get("/")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert ui.status_code == 200
    assert "Learn from your material" in ui.text
    assert "default-src 'self'" in ui.headers["content-security-policy"]


def test_readiness_contract():
    with TestClient(app) as client:
        response = client.get("/v1/readiness")
    assert response.status_code in (200, 503)
    assert response.json()["status"] in ("ready", "not_ready")


def test_api_rate_limit_returns_stable_error_and_retry_after(monkeypatch, tmp_path):
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{(tmp_path / 'rate-limits.db').as_posix()}",
        rate_limit_requests=1,
        rate_limit_window_seconds=60,
    )
    monkeypatch.setattr(api_main, "get_settings", lambda: settings)

    with TestClient(app) as client:
        first = client.get("/v1/schemas/visualization/v1")
        limited = client.get(
            "/v1/schemas/visualization/v1",
            headers={"Cookie": "eas_session=bfe4bbfc-5b7e-4324-8147-451a86561412"},
        )
        health = client.get("/v1/health")

    assert first.status_code == 200
    assert limited.status_code == 429
    assert limited.json()["code"] == "RATE_LIMITED"
    assert limited.json()["retryable"] is True
    assert limited.headers["retry-after"]
    assert health.status_code == 200


def test_request_validation_uses_structured_error_contract(monkeypatch, tmp_path):
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{(tmp_path / 'validation.db').as_posix()}"
    )
    monkeypatch.setattr(api_main, "get_settings", lambda: settings)
    with TestClient(app) as client:
        response = client.post(
            "/v1/sessions/8d88eb0f-15bf-4f53-9fd4-924dc4d81d72/turns",
            json={"query": ""},
        )
    assert response.status_code == 422
    assert response.json()["code"] == "INVALID_REQUEST"
    assert response.json()["request_id"]

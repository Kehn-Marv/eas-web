import pytest

from services.api.eas_api.config import get_settings


@pytest.fixture(autouse=True)
def isolate_default_database(monkeypatch, tmp_path):
    database = (tmp_path / "eas-test.db").as_posix()
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()

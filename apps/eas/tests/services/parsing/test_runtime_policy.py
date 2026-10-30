"""Runtime parser maintenance follows the deployment environment."""

from eas.services.parsing.runtime_policy import (
    local_parser_model_download_allowed,
    runtime_parser_maintenance_allowed,
)


def test_production_disables_runtime_parser_installs_and_model_downloads(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.delenv("EAS_ALLOW_RUNTIME_PARSER_MAINTENANCE", raising=False)

    assert runtime_parser_maintenance_allowed() is False
    assert local_parser_model_download_allowed(True) is False


def test_explicit_maintenance_override_is_supported(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("EAS_ALLOW_RUNTIME_PARSER_MAINTENANCE", "true")

    assert runtime_parser_maintenance_allowed() is True
    assert local_parser_model_download_allowed(True) is True


def test_explicit_maintenance_off_overrides_development_default(monkeypatch):
    monkeypatch.delenv("NODE_ENV", raising=False)
    monkeypatch.setenv("EAS_ALLOW_RUNTIME_PARSER_MAINTENANCE", "false")

    assert runtime_parser_maintenance_allowed() is False
    assert local_parser_model_download_allowed(True) is False

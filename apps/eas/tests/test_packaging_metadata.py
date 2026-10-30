"""Checks the web application runtime's package and requirements metadata."""

from __future__ import annotations

from pathlib import Path
import tomllib

APP_ROOT = Path(__file__).resolve().parents[1]


def _project() -> dict:
    with (APP_ROOT / "pyproject.toml").open("rb") as file:
        return tomllib.load(file)["project"]


def _requirement_lines(path: Path) -> list[str]:
    return [
        line.split("#", 1)[0].strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.split("#", 1)[0].strip()
    ]


def test_project_metadata_describes_the_web_application() -> None:
    project = _project()
    assert project["name"] == "eas"
    assert project["requires-python"] == ">=3.11,<3.15"
    assert project["license"] == {"text": "MIT"}


def test_install_does_not_publish_an_eas_terminal_command() -> None:
    scripts = _project().get("scripts", {})
    assert scripts == {}


def test_server_requirements_use_the_project_runtime() -> None:
    lines = _requirement_lines(APP_ROOT / "requirements" / "server.txt")
    assert lines == ["-e .[server]"]


def test_top_level_requirements_install_the_app_and_parsers() -> None:
    lines = _requirement_lines(APP_ROOT / "requirements.txt")
    assert lines == ["-e .[parse,graphrag,rag-lightrag,rag-rerank]"]


def test_python_314_rag_dependency_guards_are_present() -> None:
    dependencies = _project()["dependencies"]
    assert "llama-index-retrievers-bm25>=0.7.1,<0.8.0; python_version < '3.14'" in dependencies
    assert "faiss-cpu>=1.8.0,<2.0.0; python_version < '3.14'" in dependencies
    assert "faiss-cpu>=1.12.0,<2.0.0; python_version >= '3.14'" in dependencies


def test_core_mcp_and_cron_dependencies_are_in_the_application_runtime() -> None:
    dependencies = _project()["dependencies"]
    assert "mcp>=1.26.0,<2.0.0" in dependencies
    assert "croniter>=6.0.0,<7.0.0" in dependencies


def test_optional_parser_and_rag_extras_remain_available() -> None:
    extras = _project()["optional-dependencies"]
    assert extras["parse-markitdown"] == ["markitdown[all]>=0.1.7"]
    assert extras["parse-pymupdf4llm"] == ["pymupdf4llm>=1.28.2"]
    assert extras["parse-liteparse"] == ["liteparse>=2.14.2"]
    assert extras["rag-lightrag"] == ["lightrag-hku==1.5.7"]

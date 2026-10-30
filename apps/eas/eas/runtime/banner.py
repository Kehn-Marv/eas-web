"""Branded banner + labels for EAS startup.
"""

from __future__ import annotations

from rich.align import Align
from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from eas.__version__ import __version__

_ASCII_LOGO = r""" _____    _    ____  
| ____|  / \  / ___| 
|  _|   / _ \ \___ \ 
| |___ / ___ \ ___) |
|_____/_/   \_\____/ """

LABELS: dict[str, dict[str, str]] = {
    "en": {
        "tagline": "Agent-Native Personalized Tutoring",
        "lab": "EAS Intelligent Tutoring",
        # init
        "init.mode": "Workspace initializer",
        "init.workspace": "Workspace",
        "init.note_settings_dir": "Settings will be written under data/user/settings.",
        "init.cancelled": "Setup cancelled. Nothing was saved.",
        "init.step_ports": "Step {n}/{total} · Ports",
        "init.step_llm": "Step {n}/{total} · LLM provider",
        "init.step_embedding": "Step {n}/{total} · Embedding (RAG / Knowledge Base)",
        "init.step_search": "Step {n}/{total} · Web search",
        "init.step_review": "Step {n}/{total} · Review & save",
        "init.backend_port": "Backend port",
        "init.frontend_port": "Frontend port",
        "init.llm_section": "LLM provider",
        "init.pick_provider": "Pick an LLM provider",
        "init.pick_embedding_provider": "Pick an embedding provider",
        "init.show_all": "Show all providers",
        "init.custom_provider": "Custom / Other",
        "init.skip_step": "Skip / configure later",
        "init.back": "Back",
        "init.skipped": "Skipped — you can configure this later in Web Settings.",
        "init.binding": "Binding",
        "init.base_url": "Base URL",
        "init.api_key": "API key",
        "init.api_key_env_detected": "Detected {env_var}={masked} in your environment. Use it?",
        "init.api_key_prompt": "API key (input hidden, Enter to skip)",
        "init.api_key_reuse_llm": "Reuse the LLM API key {masked}?",
        "init.edit_base_url": "Edit Base URL?",
        "init.new_base_url": "New Base URL",
        "init.model": "Model",
        "init.fetch_models": "Fetching available models from {url} ...",
        "init.fetch_models_ok": "Found {count} model(s).",
        "init.fetch_models_fail": "Could not list models ({error}). Using fallback list.",
        "init.pick_model": "Pick a model",
        "init.manual_model": "Enter model name manually",
        "init.model_name_prompt": "Model name",
        "init.review_title": "Configuration review",
        "init.review_summary": "Settings to write to data/user/settings:",
        "init.confirm_save": "Save this configuration?",
        "init.saved": "Saved configuration to data/user/settings/.",
        "init.done_hint": "Run `eas start` to launch the services.",
        # start
        "start.mode": "Service launcher",
        "start.port_conflict_title": "Port conflict detected:",
        "start.port_conflict_line": "  {role} port {port} is occupied by:",
        "start.port_conflict_proc": "    PID {pid} · {command}",
        "start.port_conflict_unknown_proc": "    (could not determine process)",
        "start.port_option_change": "Change port (writes to data/user/settings/system.json)",
        "start.port_option_kill": "Stop the conflicting process and continue",
        "start.port_invalid": "Invalid port: {value}. Please enter an integer between 1-65535.",
        "start.port_saved": "Port saved to {path}.",
        "start.port_killing": "Stopping PID {pid} ({command}) ...",
        "start.port_kill_failed": "Could not free port {port} (PID {pid}).",
        "start.port_freed": "Port {port} freed.",
    }
}


def _pick_language(_value: str | None) -> str:
    return "en"


def resolve_language(_default: str = "en") -> str:
    return "en"


def labels_for(_language: str | None) -> dict[str, str]:
    return LABELS["en"]


def render_banner(language: str | None = None, *, mode_key: str | None = None) -> Panel:
    strings = LABELS["en"]
    logo = Text(_ASCII_LOGO, style="bold bright_cyan")
    tagline_line = f"{strings['tagline']}  ·  v{__version__}"

    body = Text()
    body.append(logo)
    body.append("\n\n")
    body.append(tagline_line, style="bold white")
    body.append("\n")
    body.append(strings["lab"], style="dim")
    if mode_key and mode_key in strings:
        body.append("\n")
        body.append(strings[mode_key], style="italic bright_magenta")

    return Panel(
        Align.left(body),
        title="[bold bright_cyan]EAS[/]",
        border_style="bright_cyan",
        padding=(1, 2),
    )


def print_banner(
    console: Console | None = None,
    *,
    language: str | None = None,
    mode_key: str | None = None,
) -> None:
    target = console or Console()
    target.print(render_banner(language, mode_key=mode_key))


__all__: tuple[str, ...] = (
    "LABELS",
    "labels_for",
    "print_banner",
    "render_banner",
    "resolve_language",
)

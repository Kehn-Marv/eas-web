# EAS (Educational Agentic System) — Architecture

## Overview

EAS is a web-based intelligent learning companion organized around a
focused runtime — single-shot **Tools** invoked by the LLM, and
multi-stage **Capabilities** that take over a turn. Chat requests enter
through the WebSocket API and pass through the durable turn application
service before the shared turn engine routes them to a capability.

## Architecture

```
Entry Point: WebSocket /ws
                    ↓
              ┌─────────────────────────────────────────────────┐
              │          TurnApplicationService                 │
              │   persists, coordinates, and replays turns      │
              └──────────────────────┬──────────────────────────┘
                                     ↓
              ┌─────────────────────────────────────────────────┐
              │       TurnEngine → ChatOrchestrator              │
              │   routes UnifiedContext → selected Capability    │
              │   (defaults to `chat`)                           │
              └──────────┬──────────────┬───────────────────────┘
                         │              │
              ┌──────────▼──┐  ┌────────▼──────────┐
              │ ToolRegistry │  │ CapabilityRegistry │
              │  (Level 1)   │  │   (Level 2)        │
              └──────────────┘  └────────────────────┘
```

`TurnApplicationService` owns durable turn state and replay through the
session store and runtime coordinator. Each execution uses a per-turn
`StreamBus`; the orchestrator emits events, the turn runtime persists them,
and adapters replay them to consumers. Runtime settings live in
`data/user/settings/*.json` — project-root `.env` files are intentionally
ignored.

### Level 1 — Tools

Single-function tools the LLM picks on demand. User-toggleable tools
surface in `/settings/tools`:

| Tool                 | Description                                   |
| -------------------- | --------------------------------------------- |
| `brainstorm`         | Breadth-first idea exploration with rationale |
| `web_search`         | Web search with citations                     |
| `paper_search`       | arXiv preprint search                         |
| `reason`             | Dedicated deep-reasoning LLM call             |
| `geogebra_analysis`  | Analyze math images into GeoGebra commands    |
| `imagegen`           | Generate images                               |
| `videogen`           | Generate videos                               |

`USER_TOGGLEABLE_TOOL_NAMES` in `eas/tools/builtin/__init__.py` is the
authoritative toggle list. Other built-ins are **context-gated** or
capability-owned: `CONFIGURABLE_BUILTIN_TOOL_NAMES` declares the context-gated
surface, while `eas/agents/_shared/tool_composition.py` owns the mount
rules (`ToolMountFlags`) and the always-available workspace tools.

### Level 2 — Capabilities

Multi-stage pipelines that power adaptive, visual learning:

| Capability           | Description & Stages                                  |
| -------------------- | ----------------------------------------------------- |
| `chat`               | exploring → responding (single agentic loop, default) |
| `ask_questions`      | interactive check-for-understanding via `ask_user`    |
| `deep_solve`         | step-by-step problem solver with RAG & verification   |
| `deep_question`      | dynamic question generator tailored to student mastery|
| `deep_research`      | autonomous topic research and synthesis               |
| `visualize`          | generative visual explanations (Manim, SVG, Mermaid)  |
| `math_animator`      | animation pipeline rendering complex math concepts    |
| `mastery_path`       | personalized mastery tree and guided learning journey |
| `immersive_reading`  | grounded document / textbook comprehension            |

All capabilities converge on `emit_capability_result()` in
`eas/capabilities/_shared.py` so every turn emits the same envelope
(response payload + `cost_summary` from `UsageTracker`).

## Running the web application

```bash
# Run the full app with Docker Compose from this directory.
docker compose up --build

# For web development, run the API and Next.js frontend separately.
python -m eas.api.run_server
cd web && npm run dev
```

## Key Files

| Path                                       | Purpose                              |
| ------------------------------------------ | ------------------------------------ |
| `eas/runtime/orchestrator.py`              | `ChatOrchestrator` — unified entry   |
| `eas/runtime/launcher.py`                  | Backend + frontend lifecycle / port discovery |
| `eas/runtime/registry/`                    | Tool + Capability registries         |
| `eas/runtime/bootstrap/builtin_capabilities.py` | Built-in capability class paths |
| `eas/services/config/runtime_settings.py`  | JSON settings + process-env overrides |
| `eas/core/stream.py`, `eas/runtime/stream_bus.py` | StreamEvent protocol + async fan-out |
| `eas/core/tool_protocol.py`                | `BaseTool` + `ToolDefinition`         |
| `eas/core/capability_protocol.py`          | `TurnCapability` + `CapabilityManifest` |
| `eas/core/context.py`                      | `UnifiedContext` dataclass            |
| `eas/tools/builtin/__init__.py`            | All built-in tool wrappers           |
| `eas/capabilities/`                        | Built-in capability implementations  |
| `eas/app.py`                               | `EasApp` — Python SDK facade          |
| `eas/api/routers/unified_ws.py`            | Unified WebSocket endpoint           |

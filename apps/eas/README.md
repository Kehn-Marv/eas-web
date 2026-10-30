# EAS Application Core

This directory contains the core services and web frontend of **EAS** (Educational Agentic System).

> **Full Documentation:**
> The complete project documentation, quickstart guides (Docker, local dev, and hosted web access), architectural diagrams, feature breakdowns, and configuration settings are maintained in the repository root **[README.md](../../README.md)**.

---

### Quick Directory Map
- [`eas/`](./eas): Python backend core package (FastAPI on Port 8001, cognitive pipelines, RAG engines, visualizer synthesis, and memory systems).
- [`web/`](./web): Unified Next.js 16 frontend (Serving the marketing landing page at `/` and the interactive learning space at `/chat`).
- [`scripts/`](./scripts): Architecture verifiers, environment scripts, and build automation.
- [`tests/`](./tests): Backend pytest test suite and architecture layer checks.
- [`docker-compose.yml`](./docker-compose.yml): Multi-container orchestration (Backend, Web, Redis coordinator, Sandbox runner, and PocketBase).

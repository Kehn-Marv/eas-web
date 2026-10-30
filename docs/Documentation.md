# EAS Technical Documentation

> Usage, configuration, and deployment reference for the Educational Agentic System.

---

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [Docker Compose (Recommended)](#docker-compose-recommended)
  - [Local Development Setup](#local-development-setup)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [LLM Provider Setup](#llm-provider-setup)
  - [Settings Files](#settings-files)
- [Using EAS](#using-eas)
  - [Landing Page and Entry Point](#landing-page-and-entry-point)
  - [Chat Workspace](#chat-workspace)
  - [Visualizer Engine](#visualizer-engine)
  - [Reading Workspace](#reading-workspace)
  - [Mastery Learning Paths](#mastery-learning-paths)
  - [Settings and Provider Management](#settings-and-provider-management)
- [API Reference](#api-reference)
- [Development Workflow](#development-workflow)
  - [Backend Testing](#backend-testing)
  - [Frontend Testing](#frontend-testing)
  - [Architecture Verification](#architecture-verification)
- [Deployment](#deployment)
  - [Docker Production Deployment](#docker-production-deployment)
  - [Deploying to Rumpty Cloud](#deploying-to-rumpty-cloud)
  - [Health Checks and Monitoring](#health-checks-and-monitoring)
  - [Persistent Data and Backups](#persistent-data-and-backups)
- [Troubleshooting](#troubleshooting)

---

## Overview

EAS (Educational Agentic System) is a web-based interactive learning engine that adapts how concepts are explained when text alone is not enough. It combines conversational tutoring, interactive visualizations, document-grounded citations, and guided problem solving into one unified workspace.

The system is composed of four services orchestrated via Docker Compose:

| Service | Role | Default Port |
|---|---|---|
| **eas** | All-in-one application (FastAPI backend + Next.js frontend) | 8001 (API), 3782 (Web) |
| **redis** | Session coordination, event streaming, singleflight caching | 6379 (internal) |
| **pocketbase** | OAuth and email authentication, user account storage | 8090 |
| **sandbox-runner** | Isolated execution of untrusted code in a hardened container | 8900 (internal) |

---

## Prerequisites

**For Docker deployment (recommended):**
- [Docker Engine](https://docs.docker.com/get-docker/) 24.0 or later
- [Docker Compose](https://docs.docker.com/compose/install/) v2.20 or later
- At least 4 GB available RAM
- At least 5 GB available disk space

**For local development:**
- Python 3.11 or later (3.13+ recommended)
- Node.js 20 or later
- npm 10 or later
- Redis 7.x (can run via Docker)
- Git

---

## Installation

### Docker Compose (Recommended)

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd eas-product/apps/eas

# 2. Copy and configure environment
cp .env.example .env
# Edit .env to adjust ports if defaults are occupied

# 3. Build and start all services
docker compose up -d --build

# 4. Verify all services are healthy
docker compose ps
```

The application is now available at:
- **Web interface:** `http://localhost:3782`
- **API endpoint:** `http://localhost:8001`
- **Health check:** `http://localhost:8001/health/ready`

To stop the services:
```bash
docker compose down
```

To rebuild after code changes:
```bash
docker compose up -d --build
```

### Local Development Setup

#### Backend

```bash
cd apps/eas

# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Start Redis (required)
docker run -d -p 6379:6379 --name eas-redis redis:alpine

# Start the backend server
python -m eas.api.run_server
```

The backend API starts on `http://localhost:8001` by default.

#### Frontend

```bash
cd apps/eas/web

# Install Node dependencies
npm install

# Start the development server
npm run dev
```

The frontend starts on `http://localhost:3000` by default.

---

## Configuration

### Environment Variables

Core environment variables are set in `apps/eas/.env`:

| Variable | Default | Purpose |
|---|---|---|
| `HOST_PORT_BACKEND` | `8001` | Host port for the FastAPI backend |
| `HOST_PORT_FRONTEND` | `3782` | Host port for the Next.js web interface |
| `HOST_PORT_POCKETBASE` | `8090` | Host port for PocketBase auth sidecar |
| `TZ` | `UTC` | Timezone for all containers |
| `EAS_SANDBOX_RUNNER_URL` | `http://sandbox-runner:8900` | Sandbox runner endpoint (set automatically in Docker) |
| `EAS_WORKSPACE_ROOT` | `/workspace` | Root path for user workspace files |
| `EAS_ALLOW_RUNTIME_PARSER_MAINTENANCE` | `true` | Allow runtime installation of optional document parsers |

### LLM Provider Setup

LLM provider keys can be configured in two ways:

**Via the web interface (recommended):**
1. Navigate to **Settings > Model Providers** in the sidebar.
2. Select a provider tab (Language Models, Voice, Embeddings, etc.).
3. Enter your API key and configure the endpoint.

**Via environment variables:**
```bash
OPENAI_API_KEY=sk-...          # OpenAI (GPT-4o, o3-mini)
ANTHROPIC_API_KEY=sk-ant-...   # Anthropic (Claude 3.5/3.7 Sonnet)
DASHSCOPE_API_KEY=sk-...       # Alibaba DashScope (Qwen)
PERPLEXITY_API_KEY=pplx-...    # Perplexity (online search models)
```

**Free access via OAuth:**
- In **Settings > Model Providers**, select **OpenAI Codex** and sign in with Google authentication for free-tier access without personal API keys.

**Local LLMs (Ollama, LM Studio, vLLM):**
- Set the base URL in **Settings > Model Providers** or in `data/user/settings/model_catalog.json`.
- When running inside Docker, use `host.docker.internal` instead of `localhost` to reach host-side services.

### Settings Files

Runtime settings persist under `apps/eas/data/user/settings/`:

| File | Contents |
|---|---|
| `interface.json` | Theme preferences, appearance, and UI options |
| `model_catalog.json` | Provider connections, model assignments, and API keys |
| `system.json` | Backend port, CORS, network configuration |
| `document_parsing.json` | Document parser selection and extraction options |
| `main.yaml` | Core learning policies, memory settings, and capability configuration |

---

## Using EAS

### Landing Page and Entry Point

Visiting the root URL (`/`) displays the public landing page, which introduces the three-step learning loop (Ask, Explore, Practice) and provides a prominent "Open learning space" call-to-action. No login is required to view the landing page.

### Chat Workspace

The primary learning surface lives at `/chat`. Features include:

- **Conversational tutoring:** Ask any question and receive an explanation tailored to your level. The agent uses a multi-step cognitive pipeline (Explore, Reason, Plan, Synthesize, Verify).
- **Interactive choice cards:** When the agent needs clarification, it presents clickable option cards directly in the conversation.
- **Deep research mode:** The agent can autonomously search the web (DuckDuckGo) and academic databases (ArXiv), producing structured research reports with verified citations.
- **Session management:** Conversations persist in the sidebar, and can be archived, restored, or permanently deleted from **Settings > Archived Chats**.

### Visualizer Engine

EAS generates interactive visual content directly in the chat flow:

- **Enable:** Toggle the **Visualize** switch in the chat composer, or prefix your message with `/visualize`.
- **Supported formats:** Interactive HTML/Canvas simulations, SVG scientific diagrams, Mermaid flowcharts and mindmaps, Chart.js data visualizations, GeoGebra 2D/3D mathematical constructions, and Cytoscape network graphs.
- **Sandboxed execution:** All generated code runs inside the isolated sandbox runner and cannot access the host system.

### Reading Workspace

The Reading Workspace (`/learning/reading`) provides:

- **Document upload:** Support for PDF, EPUB, DOCX, XLSX, PPTX, and Markdown files.
- **Split-screen reader:** The original document displays side-by-side with the chat, allowing simultaneous reading and conversation.
- **Citation badges:** Inline `[p.X]` badges in responses link directly to the referenced page in the document viewer.
- **Hybrid retrieval:** Questions are answered using a combination of dense vector search (FAISS) and keyword retrieval (BM25) over the indexed document content.

### Mastery Learning Paths

The Mastery Workspace (`/learning/mastery`) organizes structured learning:

- **Topic Atlas:** Curriculum topics are organized into modules, knowledge points, and review trails.
- **Practice bank:** Tracks question history, wrong-answer reviews, and spaced repetition intervals.
- **Interactive quizzes:** The agent generates multiple-choice and open-ended questions with automated grading and review feedback.

### Settings and Provider Management

The settings interface (`/settings`) provides management for:

| Section | Purpose |
|---|---|
| **Appearance** | Theme, font, and interface preferences |
| **Providers** | API key management, model assignments, endpoint configuration |
| **Tools** | Enable or disable optional tools available in chat |
| **Knowledge and Documents** | Configure document parsing and extraction options |
| **Learning Profile** | Adjust adaptive learning preferences (when active) |
| **Archived Chats** | Search, restore, or permanently delete archived conversations |

---

## API Reference

The FastAPI backend exposes its API on port 8001. Key endpoint groups:

| Endpoint Group | Purpose |
|---|---|
| `GET /health/ready` | Readiness probe (returns 200 when all subsystems are initialized) |
| `WS /api/v2/turns` | WebSocket endpoint for real-time conversation turns (v2 stream protocol) |
| `POST /api/sessions` | Create a new conversation session |
| `GET /api/sessions` | List all sessions with metadata |
| `PATCH /api/sessions/{id}/organization` | Update session preferences (archive, pin, rename) |
| `DELETE /api/sessions/{id}` | Permanently delete a session |
| `POST /api/knowledge-bases` | Create a new knowledge base from uploaded documents |
| `GET /api/knowledge-bases` | List knowledge bases with indexing status |
| `POST /api/knowledge-bases/{id}/documents` | Add documents to an existing knowledge base |
| `GET /api/settings/{section}` | Read settings for a given section |
| `PATCH /api/settings/{section}` | Update settings for a given section |
| `GET /api/mastery/topics` | List mastery topic index |
| `POST /api/auth/login` | Authenticate via email and password |
| `POST /api/auth/oauth` | Authenticate via OAuth provider |

Full interactive API documentation is available at `http://localhost:8001/docs` (Swagger UI) when the backend is running.

---

## Development Workflow

### Backend Testing

```bash
cd apps/eas

# Run the full backend test suite
pytest

# Run a specific test file
pytest tests/api/test_session_organization.py

# Run with verbose output
pytest -v

# Check architectural import boundaries
python scripts/check_architecture.py
```

### Frontend Testing

```bash
cd apps/eas/web

# TypeScript type checking
npm run typecheck

# Node.js unit tests (1,036 tests)
npm run test:node

# Vitest component tests
npm run test:unit

# ESLint
npm run lint

# i18n catalog parity and audit
npm run i18n:check

# Dependency architecture verification
npm run architecture:check

# API contract validation
npm run contracts:check

# Run all fast checks in sequence
npm run check:fast
```

### Architecture Verification

The codebase enforces strict architectural boundaries:

- **Dependency cruising:** `npm run architecture:check` validates 688 modules and 2,075 dependency edges with zero violations allowed.
- **Contract generation:** `npm run contracts:check` ensures TypeScript API types match the backend's Pydantic schemas.
- **Import layering:** The backend's `check_architecture.py` validates that service layers do not create circular imports or reach across architectural boundaries.

---

## Deployment

### Docker Production Deployment

For production hosting on a dedicated server or VM:

```bash
# 1. Clone and enter the project
git clone <your-repo-url>
cd eas-product/apps/eas

# 2. Configure environment
cp .env.example .env
# Edit .env:
#   - Set HOST_PORT_FRONTEND to 80 or your preferred port
#   - Set HOST_PORT_BACKEND to 8001
#   - Set TZ to your timezone

# 3. Build the production images
docker compose build

# 4. Start all services in detached mode
docker compose up -d

# 5. Verify health
curl http://localhost:8001/health/ready
# Expected: {"status": "ready"}

# 6. (Optional) View logs
docker compose logs -f eas
```

### Deploying to Rumpty Cloud

[Rumpty Cloud](https://rumpty.com) provides managed cloud hosting for containerized applications. The following outlines the deployment process for EAS on Rumpty.

**Preparing the project:**

1. Ensure the `docker-compose.yml` and `Dockerfile` are both present under `apps/eas/`.
2. Verify the application builds cleanly:
   ```bash
   cd apps/eas
   docker compose build
   ```
3. Confirm all tests pass before deploying:
   ```bash
   pytest
   cd web && npm run check:fast && cd ..
   ```

**Deployment steps:**

1. **Create a Rumpty Cloud account** at [rumpty.com](https://rumpty.com) and set up a new project.

2. **Connect the repository.** Link the GitHub repository containing the EAS codebase to your Rumpty project. Rumpty detects the `docker-compose.yml` and configures the service topology automatically.

3. **Configure environment variables.** In the Rumpty project dashboard, add the following environment variables:
   - `HOST_PORT_BACKEND`: `8001`
   - `HOST_PORT_FRONTEND`: `3782` (or the port Rumpty assigns)
   - `HOST_PORT_POCKETBASE`: `8090`
   - Any LLM provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
   - `TZ`: your preferred timezone

4. **Configure persistent storage.** Rumpty provides managed volumes. Map the following:
   - `./data-eas-local` to a persistent volume for application data (sessions, settings, vector indices)
   - `./data-eas-local/redis` to a persistent volume for Redis AOF data
   - `./data-eas-local/pocketbase` to a persistent volume for PocketBase auth data

5. **Deploy.** Trigger a deployment from the Rumpty dashboard or via their CLI. Rumpty builds the Docker images, provisions the network, and starts all four services (redis, pocketbase, eas, sandbox-runner) with their declared health checks.

6. **Verify.** Once deployment completes, visit the assigned URL to confirm the landing page loads. Check the health endpoint at `<your-rumpty-url>:8001/health/ready`.

7. **Set up a custom domain (optional).** In the Rumpty project settings, configure a custom domain and point your DNS records to Rumpty's provided CNAME or IP address.

> This section covers the general process. During actual deployment, the deploying agent will update this documentation with specific Rumpty CLI commands, exact volume mount paths, and any platform-specific configuration details encountered.

### Health Checks and Monitoring

All services expose health checks that Docker Compose monitors automatically:

| Service | Health Endpoint | Interval |
|---|---|---|
| **eas** | `GET /health/ready` | 30s |
| **redis** | `redis-cli ping` | 5s |
| **pocketbase** | `GET /api/health` | 10s |
| **sandbox-runner** | `GET /health` (Python urllib) | 10s |

To check service health manually:
```bash
# All services
docker compose ps

# Backend readiness
curl http://localhost:8001/health/ready

# PocketBase
curl http://localhost:8090/api/health
```

### Persistent Data and Backups

All persistent state lives under `./data-eas-local/`:

| Directory | Contents |
|---|---|
| `data-eas-local/user/settings/` | User configuration files (interface, model catalog, system) |
| `data-eas-local/user/workspace/` | Uploaded documents and workspace files |
| `data-eas-local/user/knowledge/` | Vector indices and knowledge base manifests |
| `data-eas-local/user/sessions/` | SQLite session databases |
| `data-eas-local/redis/` | Redis AOF persistence files |
| `data-eas-local/pocketbase/` | PocketBase SQLite auth database |

To back up the entire application state:
```bash
tar -czf eas-backup-$(date +%Y%m%d).tar.gz data-eas-local/
```

To restore from a backup:
```bash
docker compose down
tar -xzf eas-backup-YYYYMMDD.tar.gz
docker compose up -d
```

---

## Troubleshooting

**Backend fails to start:**
- Verify Redis is running and reachable: `docker compose logs redis`
- Check that the configured ports are not occupied: `lsof -i :8001` or `netstat -tlnp | grep 8001`
- Review backend logs: `docker compose logs eas`

**Frontend shows a blank page:**
- Confirm the backend is healthy: `curl http://localhost:8001/health/ready`
- Check the browser console for connection errors to `localhost:8001`
- For local development, ensure both backend and frontend dev servers are running

**LLM responses are not working:**
- Verify at least one provider is configured in **Settings > Model Providers**
- Check that the API key is valid and has available quota
- For local LLMs (Ollama), ensure the model is pulled and the server is running

**Document upload or indexing fails:**
- Check that the `data-eas-local/user/` directory is writable
- Verify sufficient disk space for vector index storage
- Review backend logs for parsing errors: `docker compose logs eas | grep -i "parsing\|index"`

**Sandbox runner errors:**
- Verify the runner is healthy: `docker compose ps sandbox-runner`
- Check runner logs: `docker compose logs sandbox-runner`
- Ensure the `data-eas-local/user/workspace/outputs/` directory exists and is writable

**PocketBase authentication issues:**
- Check PocketBase health: `curl http://localhost:8090/api/health`
- Review PocketBase logs: `docker compose logs pocketbase`
- For first-time setup, the PocketBase admin UI is at `http://localhost:8090/_/`

# EAS architecture and implementation map

## Architecture

```text
apps/web (same-origin browser client)
  ├─ session and upload forms
  ├─ document readiness polling
  ├─ POST + SSE turn stream, reconnect cursor, idempotency key
  ├─ citation/quick-check UI
  └─ safe VisualizationSpec renderer
       │ same-origin HTTP
services/api (FastAPI)
  ├─ session ownership + API contracts
  ├─ document, search, turn, learning, visualization routes
  ├─ shared database rate limits + OTLP spans
  └─ PostgreSQL-backed queue and object-store provider
       │ durable jobs                         │ source reads/writes
services/worker                         PostgreSQL + pgvector
  ├─ PyMuPDF/OCR preflight                     ├─ domain state
  ├─ selective Docling/MinerU                  ├─ vectors/full text
  ├─ page/block/asset persistence              ├─ job/event history
  └─ chunk/index jobs                          └─ run/signal/evaluation records
                                                │
                                       private S3-compatible storage
```

### Directory tree

```text
apps/web/                       Browser UI, CSS, and safe visual renderer
services/api/eas_api/           FastAPI routes, settings, middleware
services/worker/eas_worker/     Long-running parser and indexing worker
packages/contracts/             API response/error Pydantic contracts
packages/schemas/               VisualizationSpec schema and source validation
packages/shared/                ORM, queue, providers, retrieval, policy, evaluation
infrastructure/db/migrations/   Alembic migrations 0001–0014
infrastructure/docker/          Local PG and external Rumpty compose files
infrastructure/scripts/         Backup, restore validation, retrieval evaluation
tests/                          API, E2E, parser, retrieval, adaptive, queue, schema
```

## Database schema

PostgreSQL is the production database; SQLite is the local test/development adapter. The schema is versioned through Alembic migration `0014_shared_rate_limits`.

| Tables | Purpose |
|---|---|
| `sessions` | Anonymous learner ID, learning mode, creation/activity timestamps |
| `documents`, `document_pages`, `document_blocks`, `document_assets` | Source file, page completeness, extracted structures, private figures |
| `document_sections`, `document_chunks`, `document_embeddings`, `document_tree_nodes` | Hierarchy, provenance-preserving retrieval units, pgvector, tree index |
| `jobs`, `job_events` | Durable work state, leases, retry and lifecycle history |
| `turns`, `retrieval_events` | Grounded conversation result and hashed retrieval audit |
| `agent_runs`, `agent_steps` | Turn orchestration trace, step status, hashes, provider and timing |
| `visualization_artifacts`, `interaction_events` | Validated versioned visuals and declared interactions |
| `micro_checks`, `learning_states`, `learning_signals` | Learner answers, per-concept adaptation history, signal records |
| `provider_requests` | Provider/model operation, latency, hashes, outcome (no raw prompt/source storage) |
| `evaluation_records` | Per-case retrieval/evaluation metric results |
| `rate_limit_buckets` | Shared fixed-window API quota counters |

Source descendants preserve document/page/section/block/chunk references, hashes, and bounding boxes when available. Private asset bytes remain in the configured storage provider.

## API contract summary

All application routes are under `/v1`; owner-scoped routes require the server-issued `eas_session` HttpOnly cookie.

| Route | Contract |
|---|---|
| `POST /sessions`, `GET /sessions/{id}` | Create/read an anonymous study session |
| `POST /documents` | Multipart upload; returns `202` with document and job status |
| `GET /documents/{id}`, `/status`, `/pages/{page}` | Processing completeness and extracted page data |
| `POST /documents/{id}/pages/{page}/reprocess` | Idempotent page retry |
| `GET /documents/{id}/assets/{asset_id}` | Owner-checked private asset stream |
| `GET /jobs/{id}` | Job state and ordered `JobEvent` timeline |
| `POST /sessions/{id}/search` | Owner-scoped hybrid retrieval and context sources |
| `POST /sessions/{id}/turns` | Idempotent grounded turn; SSE `delta`, `replace`, `final`, and sanitized `error` events |
| `GET /sessions/{id}/turns` | Stored response, source citations, safe visuals, checks |
| `POST /sessions/{id}/checks`, `POST .../checks/{check_id}/answer` | Create and answer source-linked checks |
| `GET /sessions/{id}/learning-state/{concept}` | Bounded per-concept learning history |
| `GET /visualizations/{id}`, `POST /visualizations/{id}/interact` | Owned artifact and idempotent interaction |
| `GET /schemas/visualization/v1` | JSON Schema for the versioned visualization contract |
| `GET /health`, `/readiness` | Process liveness and dependency readiness |

Errors are `{code,message,details,retryable,request_id}`. Validation errors expose field locations/types without returning submitted values.

## Agent/service graph

The graph is deterministic policy orchestration, not an unconstrained agent swarm:

```text
request classification
        ↓
query planning → retrieval (sparse + vector + section candidates)
        ↓
learning-need/friction assessment → explanation planning
        ↓
LLM provider or cited extractive fallback
        ↓
citation validation → optional visualization planning → optional check planning
        ↓
response assembly + persistence (Turn, AgentRun, AgentStep, ProviderRequest)
        ↓
learner interaction → LearningSignal + LearningState → next turn context
```

`LLMProvider`, `EmbeddingProvider`, `VisionProvider`, `StorageProvider`, `ParserProvider`, and `RerankerProvider` are capability contracts. The shipped LLM/embedding clients, storage backends, parser adapters, and lexical reranker implement the capabilities used by the current application. Vision is an extension contract; image understanding currently uses parser/OCR outputs rather than a configured VLM.

## Document ingestion state machine

```text
UPLOADING → VALIDATING → STORING → PREFLIGHT → PARSING
  → OCR_FALLBACK (when required) → EXTRACTING_ASSETS
  → BUILDING_STRUCTURE → BUILDING_INDEX → VALIDATING_COVERAGE
  → READY | DEGRADED | FAILED
```

Every inventoried page receives a terminal page state. Completeness is not `READY` if pages have irrecoverable failures or degradation. Reprocessing is a durable job. Uploads stream to a temporary file under byte limits, are signature-checked and hashed, then stored by the configured provider. Each worker runs one PDF job at a time; shared PostgreSQL advisory locking caps active workers across replicas and rejects work above the queue limit.

PyMuPDF supplies preflight, quality, assets, and OCR fallback. Docling only processes flagged pages. MinerU is called for pages that trigger low-confidence/table/formula/layout signals when installed/configured. A parser startup/page error returns the PyMuPDF result with a warning.

## Adaptive policy

Friction score is a normalized weighted sum:

- explicit confusion: `0.22`
- repeated concept questions (scaled to 3): `0.18`
- failed checkpoints (scaled to 2): `0.20`
- low confidence: `0.12`
- explicit visual request: `0.10`
- procedural/complex topic: `0.06`
- recent explanation failure: `0.12`

Default thresholds are `0.25`, `0.45`, `0.70`, mapping to normal response, offer visual support, visual intervention, and visual plus micro-check. Thresholds, two-turn cooldown, and `0.08` hysteresis are configurable. Explicit interactive requests force an intervention. Check answers persist correctness, confidence, answer time, reason codes, representation history, and `LearningSignal`.

## Visualization schema

`VisualizationSpec` version `1.0` includes type, title, pedagogical goal, source references, JSON-only props, visual elements, declared interactions, state model, checkpoints, and accessibility metadata. Validation limits size/depth, rejects executable/external-resource keys, checks unique IDs and valid interaction targets, and verifies source references against retrieved objects. The browser uses text nodes and buttons for state actions; it never evaluates generated HTML/JS.

## Test strategy

- `pytest -q`: unit + API integration + end-to-end upload→worker→index→search→follow-up→stream→visual/check loop.
- Parser fixtures: text, columns, scanned, equations, tables, images, and 205-page accounting. Optional Docling corpus execution skips if not installed; MinerU/Docling adapter behavior also has mocked tests.
- Retrieval: rewrite/rerank, hybrid ranking, and measured Recall@K, citation, and page metrics.
- Adaptive, visualization schema, job lease/capacity, rate limit, ownership/private assets, and structured errors have focused coverage.
- `ruff check .`; `node --check` for every `apps/web/src/*.js`; `npm test --prefix apps/web`.
- `python infrastructure/scripts/load_smoke.py --requests 60 --concurrency 8` provides a bounded API read-path smoke test; it is not a capacity certification.
- Alembic head→downgrade→head was exercised with temporary SQLite. Compose YAML for local and Rumpty targets was configuration-validated.

## Deployment

Local PostgreSQL + pgvector:

```powershell
Copy-Item .env.example .env
docker compose --env-file .env -f infrastructure/docker/compose.yml up --build
```

Rumpty external managed PostgreSQL + private S3-compatible bucket:

```powershell
# Configure DATABASE_URL, S3_BUCKET, S3_ENDPOINT_URL, AWS credentials, secrets, and PORT in .env
docker compose --env-file .env -f infrastructure/docker/compose.rumpty.yml up --build
```

The Rumpty file does not start a database; it runs migrations against the provisioned service before API/worker startup. API binds to `0.0.0.0:$PORT`. Use the worker image build arg `PARSER_EXTRA=parser-docling` or `parser-mineru` only when that parser runtime/model capacity is provisioned. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to export traces.

For backups, `python infrastructure/scripts/backup_postgres.py` writes a compressed `pg_dump` to the private bucket. Restore verification is `python infrastructure/scripts/restore_postgres.py backup.dump` with a separately created target and explicit `EAS_RESTORE_CONFIRM`.

## Limits and next steps

1. Run Alembic migrations and verify pgvector/advisory-lock behavior against the actual RumptyCloud PostgreSQL version/image.
2. Run backup and isolated restore against that live service and target private bucket.
3. Run the browser and worker on the target Rumpty deployment, including private S3 asset streaming and multi-replica limits.
4. Collect a licensed representative scanned/complex corpus, compare PyMuPDF/Docling/MinerU, and populate a gold-labeled retrieval benchmark. The current skip/mocked/generated fixtures do not establish real-corpus accuracy.
5. Configure an OTLP collector and confirm exported trace continuity across deployment.
6. Add a real vision provider only if visual-source reasoning is required; the contract exists, but current source grounding is text/OCR based.

No live RumptyCloud credentials, Postgres/pgvector service, OTLP collector, or representative real-document corpus were available in this workspace, so those validations cannot be truthfully marked complete here.

# EAS backend

Educational Agentic System is a source-grounded adaptive learning application. This workspace contains a same-origin study UI, FastAPI service, asynchronous worker, document retrieval, adaptive checks, interactive visualizations, and production-oriented persistence and observability.

## Run locally

1. Copy `.env.example` to `.env`.
2. Install with `python -m pip install -e '.[dev]'`.
3. Run `uvicorn services.api.eas_api.main:app --reload` and open `http://localhost:8000/`.

For local PostgreSQL with pgvector, run `docker compose --env-file .env -f infrastructure/docker/compose.yml up --build`. This starts PostgreSQL, runs migrations, starts the API/UI and a worker, and uses a shared development object volume. The default compose database password is local-only. For a RumptyCloud deployment with provisioned PostgreSQL and S3-compatible private storage, set `.env` to those connection values and run `docker compose --env-file .env -f infrastructure/docker/compose.rumpty.yml up --build`. Never use the local compose defaults for a public deployment. Optional parser dependencies can be included in the worker image with `PARSER_EXTRA=parser-docling` or `PARSER_EXTRA=parser-mineru`; plan for their runtime and model-storage requirements.

Deployed environments must use `ENVIRONMENT=production`, a PostgreSQL `DATABASE_URL`, `STORAGE_BACKEND=s3`, `S3_BUCKET`, and (for S3-compatible storage) `S3_ENDPOINT_URL`. Supply credentials through the AWS environment or instance credential chain. `GET /v1/health` reports process health; `/v1/readiness` checks database connectivity.

## End-to-end learning loop

The UI creates an anonymous session, uploads a PDF or supported image, polls the exact ingest/index phases, and accepts follow-up questions. The same-origin workspace keeps sources, streamed chat, extracted source pages, citations, adaptive checks, and the visual canvas together. Follow-up turns send a bounded recent conversation to the injected LLM provider as context only; source excerpts remain the sole evidence. Turns stream answer text via SSE and then return a validated final response with citations, visualization specs, and optional quick checks. The browser retries with an idempotency key and `Last-Event-ID`; if generation restarted before a turn was stored, it replaces its partial text with the complete answer. Stored turns replay from the requested character offset. See [docs/frontend.md](docs/frontend.md) for the frontend route/component hierarchy, API map, renderer behavior, environment, deployment, limitations, and manual QA path.

Visualization specs are versioned JSON. The UI uses trusted DOM nodes and declared state actions; it does not execute generated HTML or scripts. Quick-check answers update per-concept learning state and persist `LearningSignal` records. The visual schema is available at `GET /v1/schemas/visualization/v1`.

## Architecture and operational behavior

- `services/api`: HTTP API, session ownership checks, structured error envelope, same-origin static UI, and request spans.
- `services/worker`: lease-based durable processing for ingest, reprocessing, and indexing. One job runs per worker process; PostgreSQL advisory locks bound active work across replicas.
- `packages/shared`: provider contracts/adapters, retrieval/reranking, adaptive policy, ORM models, queue primitives, and evaluation metrics.
- `apps/web`: accessible single-page study UI.
- `infrastructure/db/migrations`: schema migration history.
- `infrastructure/docker`: local PostgreSQL deployment and RumptyCloud external-service deployment templates.

The worker defaults to PyMuPDF and Tesseract OCR. Optional Docling selectively enhances low-quality, table, formula, and likely multi-column pages. Optional MinerU parses structured content. Both retain PyMuPDF quality/assets and fall back with parser warnings. Synthetic parser fixtures are not representative real-corpus evaluation.

Retrieval uses bounded lexical query variants, section-tree title candidate expansion, reciprocal-rank fusion across lexical/vector/section rankings, and a bounded second-pass lexical reranker. Dense retrieval is enabled with the OpenAI-compatible embedding settings; otherwise the index remains lexical. Use a benchmark JSON file with gold chunk IDs, citation refs, page refs, and retrieved candidates:

```powershell
python infrastructure/scripts/evaluate_retrieval.py benchmark.json --output metrics.json
```

The evaluator reports Recall@K, citation precision/recall, and exact document-page accuracy. Set `DATABASE_URL` to persist item metrics as `EvaluationRecord`s. The score is only as representative as the benchmark and its gold labels.

`JobEvent` records queued/claimed/retryable/failed/completed job transitions. `AgentRun`, `AgentStep`, `LearningSignal`, `ProviderRequest`, and `EvaluationRecord` provide persisted orchestration, learning, provider, and evaluation observability. API fixed-window rate limits are stored in the shared database and serialize atomically in PostgreSQL, keyed by client address and session ID. Tune `RATE_LIMIT_REQUESTS`, `RATE_LIMIT_WINDOW_SECONDS`, `MAX_QUEUED_JOBS`, and `MAX_RUNNING_JOBS`. Configure `OTEL_EXPORTER_OTLP_ENDPOINT` to export request, retrieval, and LLM spans over OTLP/HTTP.

Private page figures use `GET /v1/documents/{document_id}/assets/{asset_id}`. The route checks session ownership, disables caching, and removes temporary files after response delivery.

## PostgreSQL backups and restore validation

Run `python infrastructure/scripts/backup_postgres.py` with `DATABASE_URL`, a private `BACKUP_BUCKET` (or `S3_BUCKET`), standard AWS credentials, and `pg_dump` installed. The script uploads a compressed custom-format dump under `backups/eas/`.

To validate a downloaded dump, first create a separate isolated PostgreSQL database and ensure the restore user can restore the schema/extensions. Then set `SOURCE_DATABASE_URL`, `RESTORE_DATABASE_URL`, and `EAS_RESTORE_CONFIRM=restore-to-isolated-database`; run:

```powershell
python infrastructure/scripts/restore_postgres.py backup.dump
```

The script refuses to restore to the same host/database as the source and verifies required tables and pgvector. This command has not been run against a live target database in this workspace.

## Validation and remaining environment dependencies

Run `ruff check .` and `pytest -q`. Tests cover the upload→worker→index→retrieval→follow-up→SSE→visualization/check flow, ownership boundaries, adaptive state, job capacity, migrations on SQLite, provider streaming, and parser adapters. `python infrastructure/scripts/load_smoke.py --requests 60 --concurrency 8` measures the authenticated session read path against a running API. The Docling corpus test is skipped without its optional package; Docling and MinerU adapters are also tested with mocks.

This workspace had no live RumptyCloud PostgreSQL/pgvector server or credentials and no representative real scanned/complex PDF corpus. PostgreSQL-specific migrations, advisory-lock behavior, backup/restore on the target image, production OTLP delivery, and parser accuracy on actual documents still need those external resources. A live container pull of the pgvector image was not available during this implementation, so local compose was configuration-validated but not booted here.

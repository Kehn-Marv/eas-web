# EAS frontend reconstruction

## Baseline and decisions

- EAS root: `work/eas/`. Reference root: `work/pdf-to-interactive-lesson-main/pdf-to-interactive-lesson-main/`.
- Neither EAS nor the containing work folder is a Git repository. No branch or clean working-tree claim is made. The new UI is now canonical in `apps/web/`; the previous UI and pre-cutover static-mount source are preserved in `work/eas-frontend-v1-recovery-20261011/`.
- EAS is a Python package with a static browser UI mounted at `/` by FastAPI. It has no frontend package manager, bundler, component framework, shared browser contract package, or frontend build command. The least disruptive choice is a dependency-free, modular browser application served by the existing same-origin static mount.
- Baseline before edits: `ruff check .` passed; `pytest -q` reported 39 passed, 1 skipped, and one upstream urllib3 deprecation warning (21.11 s). The skipped test is the optional Docling corpus test.
- Reference package: Next.js 16.1.6, React 19.2, Tailwind CSS 4, TypeScript 5.9, pnpm 9.5. The extracted reference root has no `LICENSE`, `NOTICE`, or `COPYING` file. The reference checkout is not edited and its source, illustrations, logo, and bundled assets are not transferred. The EAS implementation independently reproduces the inspected neutral palette, typography hierarchy, whitespace, focused upload journey, reveal/motion conventions, and lesson interaction pattern. This is an intentional licensing-safe departure from importing its component source and art.

## Reference architecture map

| Route | Main composition and behavior | EAS adaptation |
|---|---|---|
| `/` | `page.tsx` → `HomeClient` → `LandingScreen`; sticky brand navigation, large hero, illustrated upload/drop surface, optional examples, illustrated learning steps, footer, scroll reveal and ambient motion. File is staged in IndexedDB before navigation. | EAS sticky nav links to its own learning steps and working session actions; original EAS vector art, animated illustrations, accessible PDF/image upload, optional direct question, reduced-motion support, no unsupported billing, API-key, demo or provider-brand controls. |
| `/generating` | `GeneratingPageContent`; reads staged file, uploads to Blob/API, tracks queue state, retry/error, then navigates to lesson. | Real EAS upload and exact ingest/index states, with retry using the same idempotency key. |
| `/courses` | `CoursesClient`/`Dashboard`; persisted owned-course cards and delete/resume/upload actions. | A compact source picker in a native dialog, backed by session-owned EAS documents. No separate dashboard/course entity. |
| `/course/[slug]` | `ModulesScreen`; saved course overview and module progress. | A single study flow whose source-linked answer, outline, checks, and follow-up are persisted EAS turns. |
| `/course/[slug]/module/[moduleIndex]` | `LessonScreen`, `ModuleCompleteScreen`, `FlowDiagram`, `DragDropQuestion`, `useCourseNavigation`; browser-history-addressable lesson and answer states. | Inline, schema-validated EAS visualization/check cards and accessible answer feedback within the grounded conversation. |
| Reference `/api/*` | Course generation, Together provider, Blob, queue, Neon/Drizzle, credits, sharing, analytics, demo, and rate limit. | Not reused. EAS has its own API and private-storage ownership contract. |

Shared reference patterns inspected include `Header`, `Footer`, `Reveal`, `LandingSteps`, `ModulesScreen`, `LessonScreen`, `FlowDiagram`, `Callout`, `Button`, `Skeleton`, and modal/drawer primitives. The global style uses Fustat, white and near-white surfaces, neutral borders, tight display tracking, restrained semantic colors, smooth/out easing, reveal transitions, and reduced-motion support. The implementation uses these design observations without copying the unlicensed component code or artwork.

## EAS capability-to-UI map

| EAS capability / contract | New UI surface and behavior | Verification |
|---|---|---|
| Anonymous session: `POST /v1/sessions`, `GET /v1/sessions/{id}`, HTTP-only `eas_session` cookie | API adapter creates or restores the session; persists only non-secret IDs locally; sends same-origin credentials. | Browser refresh/restore and backend session tests. |
| PDF/PNG/JPEG/WEBP upload: `POST /v1/documents` multipart, `Idempotency-Key`, status/job IDs | Landing picker and drag-drop; validates allowed extensions/size client-side as a usability check and leaves signature/size authority to backend; retry reuses key. | API upload tests and browser error/valid upload journeys. |
| Job and document ingest: `GET /v1/documents/{id}/status`, `GET /v1/jobs/{id}` | Study header/source dialog renders actual status/event state; polls with bounded backoff; no invented percentage. READY/DEGRADED/FAILED and fallback warnings are distinct. | Worker-backed upload where local dependencies allow; API job tests. |
| Source page, blocks, assets: `GET /v1/documents/{id}/pages/{page}`, owner-checked `/assets/{asset_id}` | On-demand source dialog, page navigation, block focus, safe text rendering, private same-origin asset images. | Citation click-through and source ownership tests. |
| Page recovery: `POST /v1/documents/{id}/pages/{page}/reprocess` | Page-level retry in source dialog; display returned queued job and refreshed status. | Reprocess endpoint tests. |
| Source search: `POST /v1/sessions/{id}/search` | Source dialog search results link to actual source pages; no fabricated snippets. | Retrieval tests and browser interaction. |
| Document removal: `DELETE /v1/documents/{id}` | Source dialog removes locally only after backend success. | Ownership/delete tests and browser error path. |
| Grounded turns/SSE: `POST /v1/sessions/{id}/turns`, body `query, document_ids, mode`, `Idempotency-Key`, `Last-Event-ID`; events `delta`, `replace`, `final`, `error`; restore with `GET /v1/sessions/{id}/turns?limit=100` | Centered lesson conversation; adaptive/interactive switch; token deltas, resumable fetch reader, same-key bounded retry, persisted turn restore. | Provider/SSE/idempotency backend tests and real browser/API turn where provider configuration permits. |
| Citations: returned `document_id, page_number, block_id, chunk_id, quote_or_excerpt, source_url` | Each returned reference opens the owned source page and focuses its matching block. None are invented. | Citation page click-through and ownership tests. |
| Visual specs v1: `GET /v1/schemas/visualization/v1`; turn specs/IDs; `GET /v1/visualizations/{id}`; `POST /v1/visualizations/{id}/interact` | Controlled trusted-DOM renderer for supported declared types/actions; IDs reload from owned endpoint; safe fallback for unknown specs; no generated HTML/scripts. | Schema/interaction unit tests, backend visualization tests, browser interaction. |
| Micro-checks: returned turn `checks`; `POST /v1/sessions/{id}/checks/{check_id}/answer`; `GET .../learning-state/{concept}` | Inline inputs based on actual check type; submitted answer and confidence/time; response feedback plus refreshed persisted state. | Adaptive/check backend tests and browser answer journey. |
| Structured errors `{code,message,details,retryable,request_id}` | API adapter keeps public messages useful, preserves request ID, and distinguishes retryable errors. | Error parser and live invalid-upload/API tests. |

## Frontend structure and migration boundary

The validated replacement is now the canonical app in `apps/web/`, with one HTML entry, local styles, API/state/rendering modules, and dependency-free browser tests. FastAPI serves it from its existing default static mount; no production route or browser build stage is required. `EAS_WEB_DIR` remains an optional, path-constrained preview override. The original UI and pre-cutover static-mount source are preserved in the sibling recovery folder `work/eas-frontend-v1-recovery-20261011/`. FastAPI contracts, worker, schemas, storage, migrations, settings, and deployment templates remain in place. The root Docker image already copies `apps/`, and the Rumpty compose file uses the same API image, so static deployment needs no browser-visible secret.

## Verification record

Initial pre-edit checks: `ruff check .` passed; `pytest -q` 39 passed, 1 skipped. No screenshot files were found beside the two repositories, so visual matching is based on the complete reference source rather than a supplied image capture. The local EAS environment does not itself prove target RumptyCloud, PostgreSQL/pgvector, real corpus/parser accuracy, or external provider availability. Those remain explicitly external integration checks.

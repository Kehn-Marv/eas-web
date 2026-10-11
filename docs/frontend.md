# EAS frontend

`apps/web-next` is the only frontend source. Its static export is generated into `apps/web` for FastAPI and Docker. The generated directory is replaced on each build so removed pages and assets cannot linger in the served app.

## Routes

- `/` is the EAS landing page and source upload entry.
- `/learn/` is the guided, source-grounded course flow: overview, lessons, citations, visual explanations, practice, and completion.
- `/chat/` is a direct conversation. A user can ask general questions without uploading a document; when their session has indexed sources, answers can be grounded in those sources. General answers are labeled and carry no fabricated citations.
- `/study/` and the old static study workspace are removed. There is one chat experience and no duplicate legacy UI.

The header has one action, Ask EAS, which opens `/chat/`. Source upload is available from the landing page and from the chat’s empty state; there is no duplicate New source header action. Unsupported demo-course, account-key, public-course, and provider-credit controls are not included.

## Backend integration

The browser uses same-origin FastAPI endpoints and the HTTP-only `eas_session` cookie. Upload creates or reuses a session, stores only session/document identifiers in browser storage, and opens `/learn/`. Guided lessons use source search, interactive turns, saved visual specs, citations, and backend-graded checks. Chat restores the session’s turns and uses the same turn API. With no documents in the session, the API uses configured general generation and returns an explicit unsourced-answer marker; without a configured language model it returns a useful setup message.

Module completion state is local to the browser because EAS does not yet expose a course-progress resource. Practice answers, turns, citations, visualizations, and visualization interactions are stored by the backend.

## Local development

Run FastAPI as described in the root README. From `apps/web-next`, run `pnpm install`, then `pnpm dev`. Set `EAS_API_ORIGIN` if the API is not at `http://127.0.0.1:8000`.

## Production

The root Dockerfile builds the Next.js static export and copies only that export into the FastAPI image. It does not copy the old generated/static web directory, so stale `/study`, PDF-to-Lesson pages, styles, or assets are not served. Set `NEXT_PUBLIC_APP_URL` for canonical and social metadata.

## Verification

Build with `STATIC_EXPORT=1 pnpm build` in `apps/web-next`. The output must include `/`, `/learn/`, and `/chat/`; it must not include `/study/`. API routes are verified through FastAPI on the same origin.

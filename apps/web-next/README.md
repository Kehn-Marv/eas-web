# EAS web frontend

This Next.js app provides the EAS landing page, guided learning path, and direct chat. Uploading material opens `/learn/`. Ask EAS opens `/chat/` and supports questions without an upload. The old `/study/` workspace and its static assets are not part of the app.

## Development

Install dependencies with `pnpm install` and run `pnpm dev`. The development server proxies `/v1` to FastAPI. Set `EAS_API_ORIGIN` if FastAPI is not at `http://127.0.0.1:8000`.

## Production

The root Dockerfile builds with `STATIC_EXPORT=1` and packages only the generated export with FastAPI. FastAPI serves the landing page, `/learn/`, `/chat/`, and the API from one origin, preserving the session cookie without browser CORS configuration. Set `NEXT_PUBLIC_APP_URL` to the deployed public origin for canonical and social metadata.

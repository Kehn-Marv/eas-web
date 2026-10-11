FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/apps/web-next
RUN corepack enable
COPY apps/web-next/package.json apps/web-next/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/web-next/ ./
ENV STATIC_EXPORT=1
RUN pnpm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml README.md ./
COPY services ./services
COPY packages ./packages
COPY --from=frontend-build /app/apps/web-next/out/ ./apps/web/
RUN pip install --no-cache-dir --timeout 600 --retries 10 .
COPY alembic.ini ./
COPY infrastructure/db/migrations ./infrastructure/db/migrations
COPY infrastructure/scripts ./infrastructure/scripts
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && if [ \"${EAS_SERVICE:-api}\" = \"worker\" ]; then exec python -m services.worker.eas_worker.web_runner; else exec uvicorn services.api.eas_api.main:app --host 0.0.0.0 --port ${PORT:-8000}; fi"]

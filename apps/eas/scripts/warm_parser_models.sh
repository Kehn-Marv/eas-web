#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="/etc/eas/eas.env"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Set EAS_DATA_HOST before downloading models." >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${EAS_DATA_HOST:?Set EAS_DATA_HOST to the mounted Rumpty volume path}"
MINERU_MODEL_SOURCE="${MINERU_MODEL_SOURCE:-huggingface}"
MINERU_MODEL_TYPE="${MINERU_MODEL_TYPE:-all}"

cd "$PROJECT_ROOT"
MODEL_VERSION_COMMAND=(python3 scripts/docker_compose.py exec -T -u eas eas python -c \
  'from importlib.metadata import version; print("docling=%s;mineru=%s" % (version("docling"), version("mineru")))')
MODEL_VERSIONS=""
for attempt in {1..60}; do
  if MODEL_VERSIONS="$("${MODEL_VERSION_COMMAND[@]}" 2>/dev/null | tr -d '\r\n')" \
    && [[ -n "$MODEL_VERSIONS" ]]; then
    break
  fi
  if [[ "$attempt" -eq 60 ]]; then
    echo "The EAS container did not become available for parser warm-up." >&2
    exit 4
  fi
  sleep 2
done

CACHE_KEY="${MODEL_VERSIONS};source=${MINERU_MODEL_SOURCE};set=${MINERU_MODEL_TYPE}"
MARKER="$EAS_DATA_HOST/model-cache/.parser-models-ready"

if [[ -r "$MARKER" ]] && [[ "$(cat "$MARKER")" == "$CACHE_KEY" ]]; then
  echo "Parser model cache is already warm for $CACHE_KEY."
  exit 0
fi

echo "Preparing the durable parser cache directories..."
python3 scripts/docker_compose.py exec -T -u eas eas python -c \
  'from pathlib import Path; [Path("/app/data/model-cache", name).mkdir(parents=True, exist_ok=True) for name in ("home", "huggingface", "modelscope", "docling", "torch", "xdg")]'

echo "Downloading Docling models into the persistent EAS data volume..."
python3 scripts/docker_compose.py exec -T -u eas eas \
  docling-tools models download --output-dir /app/data/model-cache/docling

echo "Downloading MinerU $MINERU_MODEL_TYPE models from $MINERU_MODEL_SOURCE..."
python3 scripts/docker_compose.py exec -T -u eas eas \
  mineru-models-download -s "$MINERU_MODEL_SOURCE" -m "$MINERU_MODEL_TYPE"

printf '%s\n' "$CACHE_KEY" > "$MARKER.tmp"
mv "$MARKER.tmp" "$MARKER"
echo "Parser model warm-up is complete. The model caches are stored under $EAS_DATA_HOST/model-cache."

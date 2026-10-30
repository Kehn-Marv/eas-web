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
echo "Downloading Docling models into the persistent EAS data volume..."
python3 scripts/docker_compose.py exec -T eas docling-tools models download

echo "Downloading MinerU $MINERU_MODEL_TYPE models from $MINERU_MODEL_SOURCE..."
python3 scripts/docker_compose.py exec -T eas \
  mineru-models-download -s "$MINERU_MODEL_SOURCE" -m "$MINERU_MODEL_TYPE"

echo "Parser model warm-up is complete. The model caches are stored under $EAS_DATA_HOST/model-cache."

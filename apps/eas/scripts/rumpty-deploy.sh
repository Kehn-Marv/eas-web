#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="/etc/eas/eas.env"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Set the image tags, data mount, and public port first." >&2
  exit 2
fi

set -a
# This file contains deployment paths and public image names only. Provider
# credentials belong in EAS settings, never in this file or the Git repository.
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${EAS_DATA_HOST:?Set EAS_DATA_HOST to the mounted Rumpty volume path}"
: "${EAS_IMAGE:?Set EAS_IMAGE to the published EAS image}"
: "${EAS_RUNNER_IMAGE:?Set EAS_RUNNER_IMAGE to the published runner image}"

if [[ ! -d "$EAS_DATA_HOST" ]]; then
  echo "Persistent data mount is missing: $EAS_DATA_HOST" >&2
  exit 3
fi

cd "$PROJECT_ROOT"
python3 scripts/docker_compose.py pull
python3 scripts/docker_compose.py up -d --no-build --remove-orphans
echo "Warming persistent document parser models (skips when versions are already cached)..."
bash scripts/warm_parser_models.sh
python3 scripts/docker_compose.py ps

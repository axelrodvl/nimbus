#!/usr/bin/env bash
# Build the Nimbus image (backend + web client). Everything is compiled inside containers — the host needs only Docker.
# Usage: ./scripts/build.sh [docker compose build options] [service...]
#   e.g. ./scripts/build.sh --no-cache
set -euo pipefail
source "$(dirname "$0")/common.sh"

require_docker
ensure_env

export DOCKER_BUILDKIT=1
echo "Building the Nimbus image (the first build takes several minutes; rebuilds reuse the cache)..."
docker compose build "$@"

# Pre-pull third-party images (Postgres) so start.sh does not need to download anything.
docker compose pull --quiet --ignore-buildable >/dev/null 2>&1 \
  || echo "warning: could not pre-pull postgres image; start.sh will try again." >&2

echo
echo "Build complete:"
built_images | sed 's/^/  /'
echo "Start: ./scripts/start.sh"

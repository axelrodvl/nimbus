#!/usr/bin/env bash
# Start the Nimbus stack (Postgres + Nimbus) from images built by ./scripts/build.sh.
# Does not build anything. Usage: ./scripts/start.sh
set -euo pipefail
source "$(dirname "$0")/common.sh"

require_docker
ensure_env

missing=()
for image in $(built_images); do
  docker image inspect "$image" >/dev/null 2>&1 || missing+=("$image")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "error: image not built: ${missing[*]}" >&2
  echo "Run ./scripts/build.sh first." >&2
  exit 1
fi

mkdir -p data

echo "Starting Nimbus..."
if ! docker compose up -d --no-build --wait; then
  echo >&2
  docker compose ps >&2
  echo "error: some services did not become healthy. Logs: docker compose logs --tail=100" >&2
  exit 1
fi

port="$(grep -E '^NIMBUS_PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2 || true)"
echo
echo "Nimbus is up: http://localhost:${port:-8000}"
echo "Logs: docker compose logs -f   |   Stop: ./scripts/stop.sh"

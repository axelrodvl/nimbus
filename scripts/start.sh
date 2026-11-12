#!/usr/bin/env bash
# Start the full Nimbus stack (Postgres, backend, web, Caddy) with Docker Compose.
# Works on Linux, macOS and Windows (inside WSL2). Usage: ./scripts/start.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is not installed or not in PATH." >&2
  echo "  Linux: https://docs.docker.com/engine/install/" >&2
  echo "  macOS: install Docker Desktop (https://www.docker.com/products/docker-desktop/)" >&2
  echo "  Windows: see the WSL section in README.md" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "error: the 'docker compose' plugin (Compose v2) is required." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "error: cannot talk to the Docker daemon. Is it running? (Linux: 'sudo systemctl start docker'," >&2
  echo "       macOS/Windows: start Docker Desktop; you may also need to be in the 'docker' group)." >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example (edit it to set NIMBUS_API_TOKEN, NIMBUS_MB_USER_AGENT, ...)."
fi

mkdir -p data

echo "Building and starting Nimbus (the first build takes a few minutes)..."
docker compose up -d --build --wait

port="$(grep -E '^NIMBUS_PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2 || true)"
echo
echo "Nimbus is up: http://localhost:${port:-8000}"
echo "Logs: docker compose logs -f   |   Stop: ./scripts/stop.sh"

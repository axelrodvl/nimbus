#!/usr/bin/env bash
# Запуск Nimbus из ОПУБЛИКОВАННЫХ образов (ghcr.io/axelrodvl/nimbus) — без сборки и без исходников на хосте.
# Для разработки (локальная сборка) — ./scripts/build.sh и ./scripts/start.sh.
# Использование: ./start.sh [версия]   например ./start.sh 0.3.0   (по умолчанию NIMBUS_VERSION из .env, иначе latest)
set -euo pipefail
source "$(dirname "$0")/scripts/common.sh"

require_docker
ensure_env

[ $# -gt 1 ] && { echo "usage: $0 [version]" >&2; exit 2; }
[ -n "${1:-}" ] && export NIMBUS_VERSION="${1#v}"

compose=(docker compose -f deploy/docker-compose.release.yml --project-directory .)
mkdir -p data

version="${NIMBUS_VERSION:-$(grep -E '^NIMBUS_VERSION=' .env 2>/dev/null | tail -n1 | cut -d= -f2 || true)}"
echo "Pulling published images (nimbus ${version:-latest})..."
if ! "${compose[@]}" pull --quiet; then
  echo "error: could not pull images (no network, or no such version: see https://github.com/axelrodvl/nimbus/pkgs/container/nimbus)." >&2
  exit 1
fi

echo "Starting Nimbus..."
if ! "${compose[@]}" up -d --wait; then
  echo >&2
  "${compose[@]}" ps >&2
  echo "error: some services did not become healthy. Logs: ${compose[*]} logs --tail=100" >&2
  exit 1
fi

port="$(grep -E '^NIMBUS_PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2 || true)"
echo
echo "Nimbus is up: http://localhost:${port:-8000}"
echo "Stop: ./stop.sh"

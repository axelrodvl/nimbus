#!/usr/bin/env bash
# Обновить Nimbus из ОПУБЛИКОВАННЫХ образов: если вышла новая версия образов — остановить и запустить стек заново.
# Данные (БД, ./data) сохраняются. Если новых образов нет и стек уже работает — ничего не трогает.
# Использование: ./update.sh [версия]   (как у ./start.sh: аргумент, иначе NIMBUS_VERSION из .env, иначе latest)
set -euo pipefail
cd "$(dirname "$0")"
source scripts/common.sh

require_docker
ensure_env

[ $# -gt 1 ] && { echo "usage: $0 [version]" >&2; exit 2; }
[ -n "${1:-}" ] && export NIMBUS_VERSION="${1#v}"

compose=(docker compose -f deploy/docker-compose.release.yml --project-directory .)

# Идентификаторы образов стека (пусто, если образа ещё нет локально).
image_ids() {
  local img
  while read -r img; do
    docker image inspect --format '{{.Id}}' "$img" 2>/dev/null || echo "missing:$img"
  done < <("${compose[@]}" config --images | sort -u)
}

before="$(image_ids)"
echo "Checking for new images..."
if ! "${compose[@]}" pull --quiet; then
  echo "error: could not pull images (no network, or no such version: see https://github.com/axelrodvl/nimbus/pkgs/container/nimbus)." >&2
  exit 1
fi
after="$(image_ids)"

if [ "$before" = "$after" ] && [ -n "$("${compose[@]}" ps --status running -q)" ]; then
  echo "Nimbus is already up to date and running."
  exit 0
fi

if [ "$before" = "$after" ]; then
  echo "No new images; the stack is not running — starting it."
else
  echo "New images pulled — restarting."
fi

./stop.sh
./start.sh

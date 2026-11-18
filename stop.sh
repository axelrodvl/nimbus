#!/usr/bin/env bash
# Остановить и удалить контейнеры Nimbus, запущенные ./start.sh (опубликованные образы).
# Использование: ./stop.sh [--purge]
#   --purge  ещё и удалить том БД (библиотека, настройки, плейлисты). Данные торрентов в ./data не трогаются.
# Для разработки (локальные образы) — ./scripts/stop.sh.
set -euo pipefail
source "$(dirname "$0")/scripts/common.sh"

require_docker
compose=(docker compose -f deploy/docker-compose.release.yml --project-directory .)

case "${1:-}" in
  "")
    "${compose[@]}" --profile '*' down --remove-orphans
    echo "Nimbus stopped. Data is kept (use --purge to also wipe the database)."
    ;;
  --purge)
    "${compose[@]}" --profile '*' down --remove-orphans -v
    echo "Nimbus stopped; database volume removed."
    ;;
  *)
    echo "usage: $0 [--purge]" >&2
    exit 2
    ;;
esac

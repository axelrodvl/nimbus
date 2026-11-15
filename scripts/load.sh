#!/usr/bin/env bash
# Поднимает полный стек с фейковыми внешними сервисами и большим синтетическим каталогом
# (docker-compose.load.yml, проект nimbus-load, порт 8011) и запускает сценарий Playwright из client/.
#   scripts/load.sh [load|resilience|soak]     (по умолчанию load)
# Размер каталога — NIMBUS_FAKE_ARTISTS / _ALBUMS_PER_ARTIST / _TRACKS_PER_ALBUM; задержки и отказы — NIMBUS_FAKE_LATENCY_MS / _FAILURE_RATE.
# Стек после прогона опускается (тома удаляются); KEEP_STACK=1 оставляет его для разбора.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_docker

mode="${1:-load}"
case "$mode" in
  load | resilience | soak) ;;
  *) echo "usage: $0 [load|resilience|soak]" >&2; exit 2 ;;
esac

[ "$mode" != load ] && export NIMBUS_FAKE_ARTISTS="${NIMBUS_FAKE_ARTISTS:-20}"

c="docker compose -p nimbus-load -f docker-compose.yml -f docker-compose.load.yml"
cleanup() {
  if [ "${KEEP_STACK:-0}" != 1 ]; then $c down -v >/dev/null 2>&1; fi
}
trap cleanup EXIT

$c down -v >/dev/null 2>&1
$c up -d --build --wait || { $c logs --tail=80; exit 1; }

(
  cd client
  PLAYWRIGHT_BASE_URL=http://localhost:8011 LOAD_SPEC="$mode.spec.ts" \
    bunx playwright test --config playwright.load.config.ts --trace off
)
status=$?
[ $status -ne 0 ] && $c logs --tail=120 nimbus
exit $status

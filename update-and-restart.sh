#!/usr/bin/env bash
# Обновить образы Nimbus и ВСЕГДА перезапустить стек (в отличие от ./update.sh, который перезапускает только при новых образах).
# Данные (БД, ./data) сохраняются.
# Использование: ./update-and-restart.sh [версия]   (как у ./start.sh)
set -euo pipefail
cd "$(dirname "$0")"

[ $# -gt 1 ] && { echo "usage: $0 [version]" >&2; exit 2; }

./stop.sh
./start.sh "$@"

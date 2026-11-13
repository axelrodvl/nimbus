#!/usr/bin/env bash
# Чистит backend/target от устаревших бинарников (cargo сам их не удаляет).
# Использование: ./scripts/prune-target.sh [макс. ГБ, по умолчанию 20]
set -euo pipefail
cd "$(dirname "$0")/../backend"
limit_gb="${1:-20}"
[ -d target ] || exit 0
used_gb=$(( $(du -sk target | cut -f1) / 1024 / 1024 ))
if [ "$used_gb" -gt "$limit_gb" ]; then
  echo "target/ = ${used_gb} ГБ > ${limit_gb} ГБ — очищаю"
  rm -rf target
fi

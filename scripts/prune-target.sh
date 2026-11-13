#!/usr/bin/env bash
# Ротация backend/target: cargo не удаляет старые хешированные бинарники, и target/ растёт
# до сотен ГБ. Если он больше лимита — удаляем целиком (пересоберётся сам).
# Использование: ./scripts/prune-target.sh [макс. ГБ, по умолчанию 20]
# Не трогает target, пока идёт cargo/rustc (иначе сломает чужую сборку).
set -euo pipefail
cd "$(dirname "$0")/../backend"
limit_gb="${1:-20}"
[ -d target ] || exit 0
used_gb=$(( $(du -sk target | cut -f1) / 1024 / 1024 ))
[ "$used_gb" -gt "$limit_gb" ] || exit 0
if pgrep -x -u "$(id -u)" 'cargo|rustc|cargo-llvm-cov' >/dev/null; then
  echo "target/ = ${used_gb} ГБ > ${limit_gb} ГБ, но идёт сборка — пропускаю"
  exit 0
fi
echo "target/ = ${used_gb} ГБ > ${limit_gb} ГБ — ротация (rm -rf target)"
rm -rf target

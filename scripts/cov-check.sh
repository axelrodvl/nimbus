#!/usr/bin/env bash
# Проверка порогов покрытия по JSON-отчёту `cargo llvm-cov --json`.
#   workspace >= 90 %; torrent, worker, matcher, db/src/repo/jobs.rs, api/src/stream.rs >= 95 %.
# Использование: scripts/cov-check.sh report.json
set -euo pipefail
report="${1:?usage: cov-check.sh report.json}"

# Покрытие строк (%) по файлам, чей путь содержит подстроку $1 (пусто — все); «нет» — строк нет.
pct() {
  jq -r --arg k "$1" '
    [.data[0].files[] | select(.filename | contains($k)) | .summary.lines]
    | if (map(.count) | add // 0) == 0 then "нет"
      else (100 * (map(.covered) | add) / (map(.count) | add) * 100 | round / 100 | tostring) end' "$report"
}

fail=0
check() { # имя, подстрока, минимум
  local p; p=$(pct "$2")
  if [ "$p" = "нет" ]; then echo "$1: нет строк в отчёте"; fail=1; return; fi
  echo "$1: $p % (min $3)"
  if awk -v p="$p" -v m="$3" 'BEGIN { exit !(p < m) }'; then fail=1; fi
}

check workspace "" 90
for k in crates/torrent/ crates/worker/ crates/matcher/ crates/db/src/repo/jobs.rs crates/api/src/stream.rs; do
  check "$k" "$k" 95
done
exit "$fail"

#!/usr/bin/env bash
# Проверка порогов покрытия по JSON-отчёту `cargo llvm-cov --json`.
#   workspace >= 90 %; torrent, worker, matcher, db/src/repo/jobs.rs, api/src/stream.rs >= 95 %.
# Использование: scripts/cov-check.sh report.json
# Разбор JSON — python3 (jq на машинах разработки не гарантирован).
set -euo pipefail
report="${1:?usage: cov-check.sh report.json}"
exec python3 -I - "$report" <<'PY'
import json, sys

WORKSPACE_MIN = 90.0
KEY_MIN = 95.0
KEYS = ["crates/torrent/", "crates/worker/", "crates/matcher/",
        "crates/db/src/repo/jobs.rs", "crates/api/src/stream.rs"]

files = json.load(open(sys.argv[1]))["data"][0]["files"]

def pct(sel):
    c = sum(f["summary"]["lines"]["count"] for f in files if sel(f["filename"]))
    v = sum(f["summary"]["lines"]["covered"] for f in files if sel(f["filename"]))
    return (100.0 * v / c if c else 100.0), c

failed = False
p, _ = pct(lambda n: True)
print(f"workspace: {p:.2f} % (min {WORKSPACE_MIN})")
failed |= p < WORKSPACE_MIN
for k in KEYS:
    p, c = pct(lambda n, k=k: k in n)
    if c == 0:
        print(f"{k}: нет строк в отчёте"); failed = True; continue
    print(f"{k}: {p:.2f} % (min {KEY_MIN})")
    failed |= p < KEY_MIN
sys.exit(1 if failed else 0)
PY

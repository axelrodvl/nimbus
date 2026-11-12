#!/usr/bin/env bash
# Stop the Nimbus stack. Pass --purge to also delete the database volume.
# Downloaded/cached torrent data in ./data is never removed by this script.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "${1:-}" = "--purge" ]; then
  docker compose down -v
  echo "Nimbus stopped; database volume removed."
else
  docker compose down
  echo "Nimbus stopped. Data is kept (use --purge to also wipe the database)."
fi

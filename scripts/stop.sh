#!/usr/bin/env bash
# Stop and remove the Nimbus containers. Images are kept, so ./scripts/start.sh works again without a rebuild.
# Usage: ./scripts/stop.sh [--purge]
#   --purge  also delete the database volume (library, settings, playlists).
# Downloaded/cached torrent data in ./data is never removed by this script.
set -euo pipefail
source "$(dirname "$0")/common.sh"

require_docker

case "${1:-}" in
  "")
    docker compose down --remove-orphans
    echo "Nimbus stopped. Data is kept (use --purge to also wipe the database)."
    ;;
  --purge)
    docker compose down --remove-orphans -v
    echo "Nimbus stopped; database volume removed."
    ;;
  *)
    echo "usage: $0 [--purge]" >&2
    exit 2
    ;;
esac

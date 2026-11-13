# Shared helpers for scripts/*.sh (sourced, not executed).
# Moves to the repo root and checks that Docker with Compose v2 is usable.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is not installed or not in PATH." >&2
    echo "  Linux: https://docs.docker.com/engine/install/" >&2
    echo "  macOS: install Docker Desktop (https://www.docker.com/products/docker-desktop/)" >&2
    echo "  Windows: see the WSL section in README.md" >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "error: the 'docker compose' plugin (Compose v2) is required." >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "error: cannot talk to the Docker daemon. Is it running? (Linux: 'sudo systemctl start docker'," >&2
    echo "       macOS/Windows: start Docker Desktop; you may also need to be in the 'docker' group)." >&2
    exit 1
  fi
}

# Compose reads .env for variable substitution, so make sure it exists.
ensure_env() {
  if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example (edit it to set NIMBUS_API_TOKEN, NIMBUS_MB_USER_AGENT, ...)."
  fi
}

# Images built from this repo. Compose names them <project>-<service>; the project name is fixed
# to "nimbus" in docker-compose.yml.
built_images() {
  printf '%s\n' nimbus-backend nimbus-web
}

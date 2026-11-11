set dotenv-load := true

default:
    @just --list

db-up:
    docker compose up -d db
    docker compose exec -T db sh -c 'until pg_isready -U nimbus; do sleep 1; done'

db-down:
    docker compose down

db-reset:
    docker compose down -v
    just db-up

psql:
    docker compose exec db psql -U nimbus nimbus

backend:
    @echo "not yet"

web:
    cd web && pnpm dev

web-build:
    cd web && pnpm build

web-check:
    cd web && pnpm lint && pnpm exec tsc --noEmit

test:
    @echo "not yet"

check:
    @echo "not yet"

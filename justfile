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
    @echo "not yet"

test:
    @echo "not yet"

check:
    @echo "not yet"

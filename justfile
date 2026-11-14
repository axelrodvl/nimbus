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
    cd backend && cargo run -p nimbus-api --bin nimbus

# Спецификация пишется и в web/ (старый клиент, до шага 48), и в client/.
openapi:
    cd backend && cargo run -q -p nimbus-api --bin nimbus -- --print-openapi > ../web/openapi.json
    cp web/openapi.json client/openapi.json

backend-test:
    ./scripts/prune-target.sh
    cd backend && cargo test --workspace

backend-check:
    cd backend && cargo fmt --all -- --check && cargo clippy --workspace --all-targets --features nimbus-api/test-fakes -- -D warnings

# Покрытие бэкенда: один прогон тестов, JSON-отчёт используется дважды —
# общий порог из backend/coverage-threshold.txt (только растёт) и пороги по крейтам (scripts/cov-check.sh).
# Исключены main.rs (сборка зависимостей) и тестовые двойники fakes.rs / fake_swarm.rs.
backend-cov:
    ./scripts/prune-target.sh
    cd backend && cargo llvm-cov --workspace --features nimbus-api/test-fakes \
      --ignore-filename-regex '(/main\.rs|/fakes\.rs|/fake_swarm\.rs)$' \
      --fail-under-lines "$(cat coverage-threshold.txt)" --json --output-path target/cov.json
    ./scripts/cov-check.sh backend/target/cov.json

backend-cov-html:
    cd backend && cargo llvm-cov --workspace --features nimbus-api/test-fakes \
      --ignore-filename-regex '(/main\.rs|/fakes\.rs|/fake_swarm\.rs)$' --html

cov: backend-cov client-cov

web:
    cd web && pnpm dev

web-gen-api: openapi
    cd web && pnpm gen:api

web-build:
    cd web && pnpm build

web-check:
    cd web && pnpm lint && pnpm exec tsc --noEmit

openapi-check:
    cd backend && cargo run -q -p nimbus-api --bin nimbus -- --print-openapi | diff -q - ../web/openapi.json || (echo 'web/openapi.json устарел: выполните just web-gen-api' && exit 1)
    diff -q web/openapi.json client/openapi.json || (echo 'client/openapi.json устарел: выполните just openapi' && exit 1)

# Новый клиент (client/, Vite + React на bun).
client:
    cd client && bun run dev

client-check:
    cd client && bun run lint && bun run typecheck

client-test:
    cd client && bun run test

client-cov:
    cd client && bun run test:cov

client-build:
    cd client && bun run build

client-e2e:
    cd client && bun run test:e2e --trace off

client-gen-api: openapi
    cd client && bun run gen:api

# Полный стек в контейнерах (сборка тоже в контейнерах): см. scripts/.
build *args:
    ./scripts/build.sh {{args}}

start:
    ./scripts/start.sh

stop *args:
    ./scripts/stop.sh {{args}}

up: build start

down: stop

logs:
    docker compose logs -f --tail=100

# e2e против полного стека (фейковые внешние сервисы), порт 8010.
e2e:
    #!/usr/bin/env bash
    set -uo pipefail
    c="docker compose -p nimbus-e2e -f docker-compose.yml -f docker-compose.e2e.yml"
    $c up -d --build --wait || { $c logs --tail=80; $c down -v; exit 1; }
    (cd web && PLAYWRIGHT_BASE_URL=http://localhost:8010 E2E_TOKEN=e2e-token pnpm exec playwright test --config playwright.e2e.config.ts --trace off)
    status=$?
    [ $status -ne 0 ] && $c logs --tail=80 backend
    $c down -v
    exit $status

test: backend-test client-test

check: backend-check web-check client-check

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

# Спецификация API → client/openapi.json (типы клиента: just client-gen-api).
openapi:
    cd backend && cargo run -q -p nimbus-api --bin nimbus -- --print-openapi > ../client/openapi.json

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

# Разработка: три терминала — `just db-up`, `just backend`, `just client` (http://localhost:5173, прокси /api на :8080).
dev:
    @echo 'Три терминала: just db-up (один раз) · just backend · just client → http://localhost:5173'

openapi-check:
    cd backend && cargo run -q -p nimbus-api --bin nimbus -- --print-openapi | diff -q - ../client/openapi.json || (echo 'client/openapi.json устарел: выполните just openapi' && exit 1)

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

# e2e против полного стека (фейковые внешние сервисы), порт 8010: образ собирается из корневого Dockerfile,
# Playwright — из client/ (client/playwright.stack.config.ts, client/tests/stack/).
e2e:
    #!/usr/bin/env bash
    set -uo pipefail
    c="docker compose -p nimbus-e2e -f docker-compose.yml -f docker-compose.e2e.yml"
    $c up -d --build --wait || { $c logs --tail=80; $c down -v; exit 1; }
    (cd client && PLAYWRIGHT_BASE_URL=http://localhost:8010 E2E_TOKEN=e2e-token bunx playwright test --config playwright.stack.config.ts --trace off)
    status=$?
    [ $status -ne 0 ] && $c logs --tail=80 nimbus
    $c down -v
    exit $status

test: backend-test client-test

check: backend-check client-check

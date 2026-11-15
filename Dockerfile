# syntax=docker/dockerfile:1
# Один образ: бэкенд (Rust) + собранный SPA (client/, bun). Всё собирается в контейнере — на хосте нужен только Docker.

# --- Клиент: bun install + vite build (+ предсжатие .br/.gz) ---
FROM oven/bun:1 AS client-build
WORKDIR /app/client
COPY client/package.json client/bun.lock ./
RUN --mount=type=cache,id=nimbus-bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY client ./
# Версия в интерфейсе: git-хэша в контексте нет — можно передать через --build-arg APP_VERSION.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}
RUN bun run build

# --- Бэкенд ---
FROM rust:1.99.1-bookworm AS backend-build
WORKDIR /app
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/crates ./crates
COPY backend/migrations ./migrations
# CARGO_FEATURES=test-fakes — только для e2e (docker-compose.e2e.yml).
ARG CARGO_FEATURES=""
# Кэш реестра cargo и target/ переживает пересборки (BuildKit cache mounts).
RUN --mount=type=cache,id=nimbus-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=nimbus-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=nimbus-cargo-target,target=/app/target,sharing=locked \
    cargo build --release --locked -p nimbus-api --bin nimbus ${CARGO_FEATURES:+--features $CARGO_FEATURES} \
    && cp target/release/nimbus /usr/local/bin/nimbus

# --- Итоговый образ ---
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=backend-build /usr/local/bin/nimbus /usr/local/bin/nimbus
COPY --from=client-build /app/client/dist /app/web
ENV NIMBUS_BIND=0.0.0.0:8080 NIMBUS_DATA_DIR=/data NIMBUS_WEB_DIR=/app/web
EXPOSE 8080
CMD ["nimbus"]

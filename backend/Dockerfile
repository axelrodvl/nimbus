# syntax=docker/dockerfile:1
# Сборка бэкенда целиком в контейнере: на хосте не нужны ни Rust, ни системные библиотеки.
FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
# CARGO_FEATURES=test-fakes — только для e2e (docker-compose.e2e.yml).
ARG CARGO_FEATURES=""
# Кэш реестра cargo и target/ переживает пересборки (BuildKit cache mounts):
# повторная сборка после правки кода — минуты, а не десятки минут.
RUN --mount=type=cache,id=nimbus-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=nimbus-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=nimbus-cargo-target,target=/app/target,sharing=locked \
    cargo build --release --locked -p nimbus-api --bin nimbus ${CARGO_FEATURES:+--features $CARGO_FEATURES} \
    && cp target/release/nimbus /usr/local/bin/nimbus

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/nimbus /usr/local/bin/nimbus
ENV NIMBUS_BIND=0.0.0.0:8080 NIMBUS_DATA_DIR=/data
EXPOSE 8080
CMD ["nimbus"]

FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
# CARGO_FEATURES=test-fakes — только для e2e (docker-compose.e2e.yml).
ARG CARGO_FEATURES=""
RUN cargo build --release -p nimbus-api --bin nimbus ${CARGO_FEATURES:+--features $CARGO_FEATURES}

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/nimbus /usr/local/bin/nimbus
ENV NIMBUS_BIND=0.0.0.0:8080 NIMBUS_DATA_DIR=/data
EXPOSE 8080
CMD ["nimbus"]

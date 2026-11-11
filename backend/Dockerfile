FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
RUN cargo build --release -p nimbus-api --bin nimbus

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/nimbus /usr/local/bin/nimbus
ENV NIMBUS_BIND=0.0.0.0:8080 NIMBUS_DATA_DIR=/data
EXPOSE 8080
CMD ["nimbus"]

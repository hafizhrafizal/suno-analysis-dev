# syntax=docker/dockerfile:1
# Backend image — used by CI (GitHub Actions) and local `docker compose up --build`.

# ── Build ─────────────────────────────────────────────────────────────────────
FROM rust:1-bookworm AS builder
WORKDIR /app

# Build dependencies first against a stub main.rs so this layer stays cached
# until Cargo.toml / Cargo.lock change.
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release \
    && rm -rf src target/release/deps/retrieval_backend* target/release/retrieval-backend*

COPY backend/src ./src
RUN cargo build --release

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/retrieval-backend ./retrieval-backend
EXPOSE 8000
CMD ["./retrieval-backend"]

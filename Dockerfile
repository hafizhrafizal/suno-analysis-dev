# Runtime-only image — binary is pre-built in GitHub Actions and copied in
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY binary/retrieval-backend ./retrieval-backend
EXPOSE 8000
CMD ["./retrieval-backend"]

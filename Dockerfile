# Runtime-only image — binary is pre-built in GitHub Actions and copied in
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 curl ffmpeg \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY binary/retrieval-backend ./retrieval-backend
EXPOSE 8000
CMD ["./retrieval-backend"]

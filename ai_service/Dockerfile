# syntax=docker/dockerfile:1
FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
# --mount=type=cache persists the pip download cache across builds in a BuildKit
# cache volume — packages are never re-downloaded even when requirements change.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# Models are NOT baked into the image. They are downloaded on first container
# startup and stored in the named volume ai_model_cache mounted at
# /root/.cache/huggingface. Every subsequent restart (and every rebuild) is
# instant because the volume persists across docker compose up/down cycles.

COPY main.py .

EXPOSE 8001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--timeout-keep-alive", "300"]

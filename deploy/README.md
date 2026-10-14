# Production deployment

Live at **https://suno-analysis.hafizhrafizal.com** (VPS `129.226.210.164`, Ubuntu 24.04).

## How it fits together

```
browser ──HTTPS──▶ host nginx (/etc/nginx/sites-available/suno-analysis)
                     ├─ /            → /var/www/suno-analysis   (React build, uploaded by CI)
                     └─ /api/, /static/ → 127.0.0.1:8000        (backend container)

docker compose project "suno-analysis" (~/suno-analysis/docker-compose.yml)
  backend     ghcr.io/hafizhrafizal/suno-discord-analysis-backend   127.0.0.1:8000
  ai_service  ghcr.io/hafizhrafizal/suno-discord-analysis-ai        internal only
  postgres    postgres:18-alpine                                    internal only
  qdrant      qdrant/qdrant:v1.18.1                                 127.0.0.1:6333 (API key required)
```

TLS certificates are issued by certbot (webroot `/var/www/certbot`) and renewed by `certbot.timer`;
the deploy hook reloads nginx.

## CI/CD

`.github/workflows/deploy.yml` runs on every push to `main`:

1. Builds the backend binary + runtime image, the AI service image, and the frontend.
2. **Only in `hafizhrafizal/suno-discord-analysis`:** pushes images to GHCR (tagged with the commit SHA),
   uploads the frontend and `deploy/docker-compose.prod.yml` to the VPS, then `docker compose pull && up -d`.

Other repositories (e.g. `suno-analysis-dev`) and pull requests only build — a compile/test check.

Repository secrets used by the `deploy` job (environment `production`):

| Secret | Value |
| --- | --- |
| `VPS_HOST` | `129.226.210.164` |
| `VPS_USER` | `ubuntu` |
| `VPS_SSH_KEY` | private key of `~/.ssh/ci_deploy` on the VPS |
| `VPS_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 129.226.210.164` |

## Server configuration

`~/suno-analysis/.env` (mode 600) — see `deploy/.env.example`. `APP_MODE=demo` means no login; set
`APP_MODE=multi` and run `docker compose up -d` to require accounts.

## Common operations (on the VPS, in `~/suno-analysis`)

```bash
docker compose ps                     # status
docker compose logs -f backend        # logs
docker compose up -d                  # apply .env changes
```

Backups:

```bash
# Postgres
docker compose exec -T postgres pg_dump -U retrieval -Fc retrieval > ~/backups/retrieval-$(date +%F).dump
# Qdrant (snapshot lands in the qdrant_snapshots volume)
K=$(grep ^QDRANT_API_KEY= .env | cut -d= -f2)
curl -X POST -H "api-key: $K" "localhost:6333/collections/discord_openai/snapshots?wait=true"
```

Restore: `pg_restore --no-owner --no-acl -d retrieval` for Postgres; for Qdrant copy the snapshot into
the container under `/qdrant/snapshots/discord_openai/` and call
`PUT /collections/discord_openai/snapshots/recover` with `{"location": "file:///qdrant/snapshots/discord_openai/<file>"}`.

# FarmFriend Roundtable PRO — Self-Hosting Guide

Run your own AI-powered farm advisory roundtable on your hardware. This guide covers everything from a fresh server to a production-ready deployment.

---

## Prerequisites

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **RAM**     | 4 GB    | 8 GB        |
| **CPU**     | 2 cores | 4 cores     |
| **Disk**    | 20 GB   | 40 GB SSD   |
| **OS**      | Any Linux with Docker, or macOS, or Windows (WSL2) |

**Software:**
- [Docker Engine](https://docs.docker.com/engine/install/) 24.0+
- [Docker Compose](https://docs.docker.com/compose/install/) v2.20+ (or `docker compose` plugin)
- Git

> **GPU (optional):** If you plan to run local LLMs via Ollama, an NVIDIA GPU with CUDA support dramatically improves response times. CPU-only inference works but is slower.

---

## Quick Start (5 commands)

```bash
# 1. Clone the repo
git clone https://github.com/your-org/farmfriend-roundtable-pro.git
cd farmfriend-roundtable-pro

# 2. Run the interactive setup script
bash scripts/self-host-setup.sh

# 3. The script builds images, runs migrations, and starts the app.
#    Open your browser to the URL printed at the end.
```

That's it. The setup script handles secrets, database initialization, and first startup.

---

## Manual Setup (if you prefer full control)

### 1. Configure environment

```bash
cp .env.production.example .env.production
```

Edit `.env.production` and set at minimum:

| Variable | What it's for |
|----------|---------------|
| `ALLOWED_ORIGIN` | Public URL of your instance (e.g. `https://farm.example.com`) |
| `OPENROUTER_API_KEY` | AI inference — get one free at [openrouter.ai/keys](https://openrouter.ai/keys) |
| `SESSION_SECRET` | Cookie encryption — generate with `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | Database password — generate with `openssl rand -base64 24` |

### 2. Build and start

```bash
docker compose build
docker compose up -d db
# Wait ~10s for Postgres to be healthy, then:
docker compose run --rm app npx drizzle-kit push
docker compose up -d app
```

### 3. Verify

```bash
curl http://localhost:5001/api/health
# Expected: {"status":"ok"}
```

---

## Ollama (Local AI Models)

FarmFriend can run entirely offline by pulling models through [Ollama](https://ollama.com).

### Start Ollama alongside the app

```bash
docker compose --profile ollama up -d ollama
```

### Pull a model

```bash
docker exec -it farmfriend-ollama ollama pull llama3
```

### Switch the app to local mode

In `.env.production`:

```env
OLLAMA_ENABLED=true
LOCAL_AI_BASE_URL=http://ollama:11434/v1
OLLAMA_MODEL=llama3
```

Then restart:

```bash
docker compose restart app
```

### Recommended models for farming use

| Model | Size | Notes |
|-------|------|-------|
| `llama3` | 4.7 GB | Fast, good general advice |
| `llama3.1` | 4.7 GB | Improved reasoning |
| `mistral` | 4.1 GB | Strong instruction following |
| `phi3:medium` | 7.9 GB | Best quality / size ratio |

> **Tip:** Start with `llama3`. If you have 16 GB+ RAM, `llama3.1` or `phi3:medium` give noticeably better farm-planning responses.

---

## HTTPS / TLS Setup

Do **not** expose port 5001 directly to the internet without a reverse proxy. Use **Caddy** (easiest) or **nginx**.

### Option A: Caddy (automatic HTTPS)

```bash
# Install Caddy: https://caddyserver.com/docs/install
```

Create `/etc/caddy/Caddyfile`:

```
farm.example.com {
    reverse_proxy localhost:5001
}
```

```bash
sudo systemctl reload caddy
```

Caddy automatically obtains and renews Let's Encrypt certificates.

### Option B: nginx

```nginx
server {
    listen 80;
    server_name farm.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name farm.example.com;

    ssl_certificate     /etc/letsencrypt/live/farm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/farm.example.com/privkey.pem;

    location / {
        proxy_pass         http://localhost:5001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Update `.env.production`:

```env
ALLOWED_ORIGIN=https://farm.example.com
```

---

## Updating

```bash
cd farmfriend-roundtable-pro
git pull origin main
docker compose down
docker compose build --no-cache
docker compose up -d db
sleep 10
docker compose run --rm app npx drizzle-kit push
docker compose up -d app
```

> Always run migrations after pulling updates that change the database schema.

---

## Farm-Specific Configuration

### Local weather integration

Set your farm's GPS coordinates in `.env.production`:

```env
OWM_API_KEY=your-openweathermap-key
FARM_LOCATION_LAT=41.8781
FARM_LOCATION_LON=-87.6298
```

The Research Analyst will include current conditions and forecasts in its advice. Get a free API key at [openweathermap.org/api_keys](https://home.openweathermap.org/api_keys).

### Offline / air-gapped operation

1. Enable Ollama (`OLLAMA_ENABLED=true`)
2. Do **not** set `OPENROUTER_API_KEY` if you want to block cloud AI entirely
3. The app will route all inference through your local model

### Custom model selection

Edit `.env.production`:

```env
OLLAMA_MODEL=llama3.1
```

Restart the app container to apply.

---

## Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | `production` | Must stay `production` |
| `ALLOWED_ORIGIN` | Yes | — | Public URL for CORS |
| `PORT` | Yes | `5001` | Internal container port |
| `DATABASE_URL` | Yes | — | Postgres connection string |
| `POSTGRES_DB` | Yes | `farm_roundtable_prod` | Database name |
| `POSTGRES_USER` | Yes | `farmuser` | Database user |
| `POSTGRES_PASSWORD` | Yes | — | Database password |
| `SESSION_SECRET` | Yes | — | 64-char hex random string |
| `OPENROUTER_API_KEY` | Yes* | — | Cloud AI provider |
| `PERPLEXITY_API_KEY` | No | — | Web search for Research Analyst |
| `LOCAL_AI_BASE_URL` | No | `http://localhost:11434/v1` | Local AI endpoint |
| `LOCAL_AI_API_KEY` | No | — | Rarely needed for local AI |
| `OLLAMA_ENABLED` | No | `false` | Enable Ollama service |
| `OLLAMA_MODEL` | No | `llama3` | Default local model |
| `STRIPE_SECRET_KEY` | No | — | Payments (production only) |
| `VITE_STRIPE_PUBLIC_KEY` | No | — | Stripe publishable key |
| `STRIPE_PRICE_ID` | No | — | Subscription price ID |
| `STRIPE_WEBHOOK_SECRET` | No | — | Stripe webhook signing secret |
| `OWM_API_KEY` | No | — | Weather data |
| `FARM_LOCATION_LAT` | No | — | Farm latitude |
| `FARM_LOCATION_LON` | No | — | Farm longitude |

\* Required unless running fully offline with Ollama.

---

## Troubleshooting

### `docker compose build` fails with "node-gyp" errors

Some native dependencies need build tools. The Dockerfile already installs `python3 make g++`, but if you're building outside Docker:

```bash
# macOS
xcode-select --install

# Debian/Ubuntu
sudo apt-get install -y build-essential python3
```

### Database connection refused

Check that the `db` service is healthy:

```bash
docker compose ps
docker compose logs db
```

Ensure `DATABASE_URL` uses hostname `db` (not `localhost`) when running inside Docker.

### App starts but shows a blank page

The client build may have failed. Check:

```bash
docker compose logs app
```

Look for `Could not find the build directory` — run `docker compose build` again.

### CORS errors in browser

`ALLOWED_ORIGIN` must exactly match the URL in your browser's address bar, including `http` vs `https` and port.

### Ollama is slow / times out

- CPU inference is slow. A modern GPU with 8 GB+ VRAM is strongly recommended.
- Try a smaller model: `ollama pull phi3` instead of `llama3.1`.
- Increase the request timeout in your reverse proxy if needed.

### Stripe webhooks fail in production

Stripe requires a publicly reachable HTTPS endpoint. Use the Caddy or nginx setup above, then configure your webhook URL in the Stripe Dashboard to point to `https://your-domain.com/api/stripe/webhook`.

---

## Support

- **Issues:** [GitHub Issues](https://github.com/your-org/farmfriend-roundtable-pro/issues)
- **Discussions:** [GitHub Discussions](https://github.com/your-org/farmfriend-roundtable-pro/discussions)
- **Docs:** See `README.md` for developer setup and architecture overview.

---

*Happy farming. May your yields be high and your pests few.*

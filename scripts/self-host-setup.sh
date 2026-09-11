#!/usr/bin/env bash
# FarmFriend Roundtable PRO — Self-Host Setup Script
# Usage:  bash scripts/self-host-setup.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.production"
EXAMPLE_ENV="${REPO_ROOT}/.env.production.example"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERR]${NC}   $*" >&2; }

# ─── 1. Prerequisites ─────────────────────────────────────────────────────────
info "Checking prerequisites..."

if ! command -v docker &>/dev/null; then
  err "Docker is not installed. Install it first:"
  err "  https://docs.docker.com/engine/install/"
  exit 1
fi
ok "Docker found: $(docker --version)"

if ! command -v docker-compose &>/dev/null && ! docker compose version &>/dev/null; then
  err "docker-compose (or 'docker compose' plugin) is not installed."
  err "  https://docs.docker.com/compose/install/"
  exit 1
fi
ok "Docker Compose found"

# ─── 2. Environment file ──────────────────────────────────────────────────────
info "Setting up environment file..."

if [[ -f "$ENV_FILE" ]]; then
  warn ".env.production already exists."
  read -rp "Overwrite with fresh copy from example? [y/N] " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    cp "$EXAMPLE_ENV" "$ENV_FILE"
    ok "Copied fresh .env.production"
  else
    ok "Keeping existing .env.production"
  fi
else
  cp "$EXAMPLE_ENV" "$ENV_FILE"
  ok "Created .env.production from example"
fi

# ─── 3. Generate / prompt for secrets ─────────────────────────────────────────
info "Configuring secrets..."

prompt_or_generate() {
  local var_name="$1"
  local current_val
  current_val=$(grep "^${var_name}=" "$ENV_FILE" | cut -d'=' -f2- || true)

  if [[ "$current_val" == \[REQUIRED\]* ]] || [[ "$current_val" == "change-me"* ]] || [[ -z "$current_val" ]]; then
    read -rp "Enter ${var_name} (press Enter to auto-generate): " user_val
    if [[ -z "$user_val" ]]; then
      if [[ "$var_name" == "SESSION_SECRET" ]]; then
        user_val="$(openssl rand -hex 32)"
      elif [[ "$var_name" == "POSTGRES_PASSWORD" ]]; then
        user_val="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)"
      else
        user_val="$(openssl rand -hex 16)"
      fi
      ok "Auto-generated ${var_name}"
    fi
    sed -i.bak "s|^${var_name}=.*|${var_name}=${user_val}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    ok "${var_name} already set"
  fi
}

prompt_or_generate "POSTGRES_PASSWORD"
prompt_or_generate "SESSION_SECRET"

# Prompt for OpenRouter (required)
read -rp "Enter your OpenRouter API key (get one at https://openrouter.ai/keys): " or_key
if [[ -n "$or_key" ]]; then
  sed -i.bak "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=${or_key}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  ok "OpenRouter API key configured"
else
  warn "No OpenRouter key provided. The app will fail to start until you add one."
fi

# Prompt for ALLOWED_ORIGIN
read -rp "Enter your public domain or IP (e.g., https://farm.example.com or http://192.168.1.50:5001): " origin
if [[ -n "$origin" ]]; then
  sed -i.bak "s|^ALLOWED_ORIGIN=.*|ALLOWED_ORIGIN=${origin}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  ok "ALLOWED_ORIGIN set to ${origin}"
fi

# ─── 4. Build images ──────────────────────────────────────────────────────────
info "Building Docker images..."
cd "$REPO_ROOT"
docker compose build
ok "Docker images built"

# ─── 5. Start database ────────────────────────────────────────────────────────
info "Starting PostgreSQL..."
docker compose up -d db

# Wait for Postgres to be healthy
info "Waiting for database to be ready..."
for i in {1..30}; do
  if docker compose ps db | grep -q "healthy"; then
    ok "Database is healthy"
    break
  fi
  sleep 1
  if [[ $i -eq 30 ]]; then
    err "Database failed to become healthy within 30s"
    docker compose logs db
    exit 1
  fi
done

# ─── 6. Run migrations ────────────────────────────────────────────────────────
info "Running database migrations..."
docker compose run --rm app npx drizzle-kit push
ok "Migrations applied"

# ─── 7. Start the app ─────────────────────────────────────────────────────────
info "Starting FarmFriend Roundtable PRO..."
docker compose up -d app
ok "App container started"

# ─── 8. Print instructions ────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo -e "  ${GREEN}FarmFriend Roundtable PRO is starting up!${NC}"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""
echo "  App URL:     ${ALLOWED_ORIGIN:-http://localhost:5001}"
echo "  Logs:        docker compose logs -f app"
echo "  Database:    docker compose logs -f db"
echo "  Stop:        docker compose down"
echo "  Restart:     docker compose restart app"
echo ""
echo "  To enable local AI (Ollama):"
echo "    docker compose --profile ollama up -d ollama"
echo "    docker exec -it farmfriend-ollama ollama pull llama3"
echo ""
echo "  Next steps:"
echo "    1. Open your browser to the App URL above."
echo "    2. Create your first admin account."
echo "    3. (Optional) Configure HTTPS with a reverse proxy (Caddy/nginx)."
echo "    4. (Optional) Set up Stripe keys in .env.production for subscriptions."
echo ""
echo "  For help, see README-SELF-HOST.md"
echo "═══════════════════════════════════════════════════════════════════════════════"

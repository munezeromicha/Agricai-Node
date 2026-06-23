#!/usr/bin/env bash
# Idempotent PM2 deploy: Agricai-Node platform API on port 3008.
#   chmod +x scripts/pm2-deploy.sh && ./scripts/pm2-deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="Agricai-Node"

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example and set GEMINI_API_KEY, JWT_SECRET, CORS_ORIGINS, SUPERADMIN_*" >&2
  exit 1
fi

npm install --omit=dev

pm2 delete "$APP_NAME" 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo ""
pm2 list
echo ""
echo "Smoke test:"
curl -sf "http://127.0.0.1:3008/health" && echo || {
  echo "Health check failed. Run: pm2 logs $APP_NAME --lines 50" >&2
  exit 1
}

#!/usr/bin/env bash
# Idempotent PM2 deploy: Agricai-Node platform API on port 3008.
#   chmod +x scripts/pm2-deploy.sh && ./scripts/pm2-deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="Agricai-Node"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Node.js 18+ required (current: $(node -v)). Install Node 20 LTS recommended." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example and set GEMINI_API_KEY, JWT_SECRET, CORS_ORIGINS, SUPERADMIN_*" >&2
  exit 1
fi

npm install --omit=dev

# Catch a bad environment BEFORE restarting, so a misconfiguration cannot turn a
# running API into a crash loop (Caddy would answer 502 with no CORS headers).
#
# --pre-deploy checks configuration only. Without it the gate also blocks on "nothing
# is listening on :3008" and "api.agric-ai.com returns 502" — the very symptoms of the
# outage this script exists to end, which deadlocked a real recovery.
if ! NODE_ENV=production node scripts/doctor.mjs --pre-deploy; then
  echo "" >&2
  echo "Deploy stopped: fix the problems above, then re-run this script." >&2
  echo "The currently running API (if any) was left untouched." >&2
  exit 1
fi

pm2 delete "$APP_NAME" 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo ""
pm2 list
echo ""
echo "Smoke test:"
curl -sf "http://127.0.0.1:3008/health" && echo "OK /health" || {
  echo "Health check failed. Run: pm2 logs $APP_NAME --lines 50" >&2
  exit 1
}
curl -sfI -X OPTIONS "http://127.0.0.1:3008/api/auth/login" \
  -H "Origin: https://agric-ai.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" \
  | grep -qi "access-control-allow-origin" && echo "OK CORS preflight" || {
  echo "CORS preflight missing Access-Control-Allow-Origin. Check CORS_ORIGINS and server.mjs" >&2
  exit 1
}

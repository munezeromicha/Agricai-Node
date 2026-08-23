# Deploy Agricai-Node (api.agric-ai.com)

The frontend at **https://agric-ai.com** calls **https://api.agric-ai.com** for login, chat, weather, and contact.

If you see **502 Bad Gateway** or **CORS blocked** on `https://agric-ai.com`, the Node API is usually **not running** behind Caddy. Browsers report *“No Access-Control-Allow-Origin”* because **Caddy’s 502 response has no CORS headers** — fix the API first, not the frontend.

Quick check from your laptop:

```bash
curl -sI https://api.agric-ai.com/health
```

- `HTTP/2 200` + JSON body → API is up; then check `CORS_ORIGINS` if login still fails.
- `HTTP/1.1 502` → PM2 process down or wrong port. On the server: `pm2 logs Agricai-Node --lines 50`

**One command that explains a 502.** On the server (or locally before deploying):

```bash
cd Agricai-Node && npm run doctor
```

It checks, in the order a request meets them: `.env` values, `JWT_SECRET` strength,
`CORS_ORIGINS`, the SuperAdmin seed, the data store's readability and permissions, whether
anything is actually listening on port 3008, and the public `https://api.agric-ai.com/health`.
Every failure prints the command that fixes it. It exits non-zero, and `scripts/pm2-deploy.sh`
runs it **before** restarting — a bad environment stops the deploy instead of turning a running
API into a crash loop.

## Startup guard: JWT_SECRET

With `NODE_ENV=production`, the API refuses to start unless `JWT_SECRET` is set, is not the
example placeholder, and is at least 32 characters. A guessable signing key would let anyone mint
a SuperAdmin token, so this is deliberate — but it means a weak secret shows up as a **502**, with
the reason printed in `pm2 logs Agricai-Node`.

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
# put the value in Agricai-Node/.env as JWT_SECRET=…
pm2 restart Agricai-Node
```

Rotating `JWT_SECRET` signs everyone out; they log in again and no data is lost.

Common crash on Node 18: `undici@7` → `ReferenceError: File is not defined`. Use `undici@6` (see `package.json`) and redeploy.

## 1. Server `.env`

On the production server, in `Agricai-Node/.env`:

```env
PORT=3008
CORS_ORIGINS=https://agric-ai.com,https://www.agric-ai.com
JWT_SECRET=<strong-random-secret>
GEMINI_API_KEY=<your-key>
SUPERADMIN_EMAIL=admin@agric-ai.com
SUPERADMIN_PASSWORD=<strong-password>
```

Production domains are also allowed by default in code, but setting `CORS_ORIGINS` is recommended.

## 2. Start with PM2

```bash
cd Agricai-Node
chmod +x scripts/pm2-deploy.sh
./scripts/pm2-deploy.sh
```

Verify locally on the server:

```bash
curl -s http://127.0.0.1:3008/health
```

## 3. Caddy reverse proxy

Ensure your Caddyfile includes (see `deploy/Caddyfile`):

```
api.agric-ai.com {
    reverse_proxy 127.0.0.1:3008
}
```

Reload Caddy after changes.

## 4. Verify production

```bash
curl -s https://api.agric-ai.com/health
curl -sI -X OPTIONS https://api.agric-ai.com/api/auth/login \
  -H "Origin: https://agric-ai.com" \
  -H "Access-Control-Request-Method: POST"
```

You should get `200` or `204` with `Access-Control-Allow-Origin: https://agric-ai.com`.

## Stack summary

| Host | Service | Port |
|------|---------|------|
| agric-ai.com | Static frontend (Vite build) | — |
| ai.agric-ai.com | Agricai-Python (detect) | 8000 |
| api.agric-ai.com | Agricai-Node (auth/chat) | 3008 |

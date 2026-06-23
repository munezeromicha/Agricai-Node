# Deploy Agricai-Node (api.agric-ai.com)

The frontend at **https://agric-ai.com** calls **https://api.agric-ai.com** for login, chat, weather, and contact.

If you see **502 Bad Gateway** or **CORS blocked**, the Node API is usually **not running** behind Caddy (the browser shows CORS because the proxy error has no `Access-Control-Allow-Origin` header).

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

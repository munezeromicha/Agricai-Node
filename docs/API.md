# AGRIC AI Platform API

Node service (port **3008**) — auth, users, weather, crops, billing.

Vision detection lives on the Python service (port **8000**): `POST /v1/detect`.

## Quick start

```bash
cd Agricai-Node
npm install
cp .env.example .env   # set JWT_SECRET, optional GEMINI_API_KEY
npm run dev
```

- Health: `GET http://localhost:3008/health`
- Swagger UI: `GET http://localhost:3008/api/docs`
- OpenAPI JSON: `GET http://localhost:3008/api/openapi.json`

## Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | `{ name, email, password, role? }` |
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/refresh` | `{ refreshToken }` |
| GET | `/api/auth/me` | Bearer token — profile + usage |

## Users

| Method | Path | Description |
|--------|------|-------------|
| PATCH | `/api/users/me` | Update name / language |
| GET | `/api/users/me/scans` | Scan history |
| POST | `/api/users/me/scans` | Record scan (enforces free tier limit) |
| GET | `/api/users/me/usage` | Scans today vs limit |

## Weather

`GET /api/weather?lat=-1.94&lon=30.06` — cached Open-Meteo proxy.

## Crops

| Method | Path |
|--------|------|
| GET | `/api/crops` |
| GET | `/api/crops/:slug` |

Data: `data/crops.json` (synced from frontend `src/data/crops.ts`).

## Billing

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/billing/plans` | Public |
| GET | `/api/billing/subscription` | Auth required |
| POST | `/api/billing/checkout` | `{ plan: "pro" \| "enterprise" }` — stub mode activates Pro without Stripe |

Set `BILLING_STUB_MODE=false` and `STRIPE_SECRET_KEY` for live payments.

## Storage

User data: `data/store.json` (gitignored). Replace with PostgreSQL for production scale.

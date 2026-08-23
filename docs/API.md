# AGRIC AI Platform API

Node service (port **3008**) — auth, users, scans, feedback, recommendations, weather, crops, billing, analytics.

Vision detection lives on the Python service (port **8000**): `POST /v1/detect`.

## Quick start

```bash
cd Agricai-Node
npm install
cp .env.example .env   # set JWT_SECRET, optional GEMINI_API_KEY
npm run dev
npm test               # node:test suite (no external services needed)
```

- Health: `GET http://localhost:3008/health`
- Swagger UI: `GET http://localhost:3008/api/docs`
- OpenAPI JSON: `GET http://localhost:3008/api/openapi.json`

All responses use `{ ok: true, ... }` / `{ ok: false, message, code? }`.

## Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | `{ name, email, password, phone?, district? }` |
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/refresh` | `{ refreshToken }` — rotates the refresh token |
| POST | `/api/auth/logout` | `{ refreshToken }` — revokes it server-side |
| GET | `/api/auth/me` | Bearer token — profile + usage |

Auth endpoints are rate limited to 30 requests per 15 minutes per IP.
`JWT_SECRET` must be set (≥32 chars) when `NODE_ENV=production` — the process refuses to boot otherwise.

## Users and scans

| Method | Path | Description |
|--------|------|-------------|
| PATCH | `/api/users/me` | Update name / language / phone / district |
| GET | `/api/users/me/scans?limit=50` | Scan history with confidence bands |
| POST | `/api/users/me/scans` | Record a scan (enforces the daily limit) |
| POST | `/api/users/me/scans/sync` | Replay offline-queued scans (max 50 per batch) |
| GET | `/api/users/me/usage` | Scans/chats today vs limit |

**Recording a scan**

```json
{
  "clientId": "8b2f…",            // idempotency key from the device
  "diseaseName": "Late Blight",
  "diseaseNameRw": "Kirabiranya",
  "confidence": 93.4,
  "marginPct": 40,                 // gap to the runner-up class
  "crop": "tomato",
  "type": "disease",
  "topClassId": "tomato_late_blight",
  "alternatives": [{ "class_id": "early_blight", "disease_name": "Early Blight", "confidence": 12 }],
  "modelVersion": "tomato-disease-b518h/3",
  "inferenceMode": "roboflow",
  "latitude": -1.4998,             // optional GPS
  "longitude": 29.6339,
  "accuracyM": 12,
  "capturedAt": 1770000000000
}
```

The server derives `confidenceLevel` (`high | medium | low | very_low`) and returns bilingual
`confidenceGuidance`. Re-posting the same `clientId` returns the stored scan with `duplicate: true`
instead of creating a second record — this is what makes offline replay safe.

`/scans/sync` answers with a per-item result list:

```json
{ "accepted": 3, "duplicates": 1, "rejected": 1,
  "results": [{ "clientId": "…", "status": "accepted", "scanId": "…" }] }
```

## Feedback

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/scans/:id/feedback` | `{ verdict: "correct"\|"incorrect"\|"unsure", actualDisease?, rating?, comment? }` |
| GET | `/api/users/me/feedback` | The farmer's own verdicts |
| GET | `/api/admin/feedback?limit=200` | SuperAdmin — all verdicts with farmer identity |

One verdict per scan: posting again updates it. Feedback is the only ground truth behind the
`modelQuality.accuracyPct` figure in analytics.

## Recommendations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/recommendations?crop=&lat=&lon=&persist=` | Prioritised bilingual action list |
| GET | `/api/recommendations/saved` | Previously persisted recommendations |
| POST | `/api/recommendations/:id/complete` | `{ done: true }` — tick an item off |

Inputs: the farmer's last 50 scans, the crop, and the local forecast. Output is ordered
`urgent → high → medium → low` with categories `treatment`, `spray_window`, `irrigation`,
`fertilizer`, `monitoring`, `harvest`, `advisory`. `persist=true` stores the list.

## Farms and notifications

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/farms` | Farms + last known GPS anchor |
| POST | `/api/farms` | `{ name?, latitude, longitude, accuracyM?, district?, sizeHa? }` |
| GET | `/api/notifications` | In-app notifications + unread count |
| POST | `/api/notifications/:id/read` | Mark one read |

## Weather

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/weather?lat=&lon=` | Cached Open-Meteo forecast (7 days, rain + wind + humidity) |
| GET | `/api/weather/intelligence?lat=&lon=` | Forecast **plus** disease-pressure index, spray windows and advisories |

Coordinates are rounded to ~1 km before caching, so a village shares one upstream call.
A stale cached forecast is served (with `stale: true`) rather than an error when Open-Meteo is down.

`intelligence` payload:

```json
{ "riskIndex": 78, "riskLevel": "high", "rain7dMm": 42.3, "dryStreakDays": 0,
  "nextGoodSprayDate": "2026-03-12",
  "sprayWindows": [{ "date": "2026-03-11", "suitable": false, "rating": "poor", "blockers": ["rain"] }],
  "advisories": [{ "code": "fungal_pressure", "priority": "high", "titleEn": "…", "titleRw": "…", "bodyEn": "…", "bodyRw": "…" }] }
```

## SuperAdmin

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/stats` | Headline counters |
| GET | `/api/admin/analytics?days=30` | Executive dashboard payload |
| GET | `/api/admin/users` | All users |
| PATCH | `/api/admin/users/:id` | Rename / change role |
| DELETE | `/api/admin/users/:id` | Delete a user and their data |
| GET | `/api/admin/scans?limit=100` | All scans with owner identity |
| GET | `/api/admin/feedback?limit=200` | All feedback |

`/api/admin/analytics` returns `totals`, `growth` (daily series + week-over-week change),
`engagement` (active/returning farmers), `modelQuality` (farmer-verified accuracy, confidence bands),
`distribution` (crop / disease / district, GPS and offline share), `surveillance` (outbreak alerts)
and `revenue`.

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

Set `BILLING_STUB_MODE=false` and `STRIPE_SECRET_KEY` for live payments. Stub activations are
recorded in the `payments` collection so revenue reporting has one source.

## Storage

The default driver is the JSON file store (`DATABASE_PATH`, default `./data/store.json`), written
atomically. Collections mirror the PostgreSQL tables in [`src/db/schema.sql`](../src/db/schema.sql) —
see [DATABASE.md](./DATABASE.md) for the migration path.

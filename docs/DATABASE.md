# Database

## What runs today

The API stores everything in a single JSON file (`DATABASE_PATH`, default `./data/store.json`).

Why this is still the default:

- the pilot runs on one PM2 instance (`instances: 1`), so there is no cross-process write race;
- writes go through a temp file + `rename`, so a crash mid-write cannot truncate the store;
- reads are served from an in-process cache that is invalidated by the file's mtime;
- zero infrastructure to provision, back up, or pay for while the farmer base is small.

It stops being the right choice at roughly: more than one API instance, more than ~50k scans,
or the first report that needs a real query (`GROUP BY district, week`). At that point move to
PostgreSQL — the shapes already match.

## Collections ↔ tables

| JSON collection | PostgreSQL table | Notes |
|---|---|---|
| `users` | `farmers` | `role` in (`farmer`, `agronomist`, `superadmin`) |
| `farms` | `farms` | GPS anchor for weather + surveillance |
| — (`data/crops.json`) | `crops` | Static catalogue, loaded from disk today |
| — (`Agricai-Python/data/classes.json`) | `diseases` | Model class library |
| `scans` | `crop_scans` + `predictions` | One JSON record splits into the scan (where/when) and the prediction (what/how sure) |
| `weatherObservations` | `weather` | Forecast snapshots + risk index |
| `recommendations` | `recommendations` | Engine output, with `status` for follow-through |
| `feedback` | `feedback` | One verdict per scan (`UNIQUE (scan_id)`) |
| `subscriptions` / `payments` | `payments` | Stub activations are recorded as paid rows of 0 |
| — | `agronomists` | Table exists; the referral workflow is not built yet |
| `notifications` | `notifications` | In-app today; `channel` allows SMS/push later |
| `refreshTokens` | `refresh_tokens` | Hashes only, never raw tokens |

`src/db/schema.sql` is the authoritative DDL for all twelve tables.

## Field mapping that is not one-to-one

A stored scan carries both scan and prediction data:

```
scan.id            → crop_scans.id
scan.userId        → crop_scans.farmer_id
scan.clientId      → crop_scans.client_id       (UNIQUE with farmer_id — offline idempotency)
scan.latitude/…    → crop_scans.latitude/longitude/accuracy_m
scan.capturedAt    → crop_scans.captured_at
scan.syncedOffline → crop_scans.synced_offline

scan.diseaseName      → predictions.disease_name
scan.confidence       → predictions.confidence
scan.confidenceLevel  → predictions.confidence_level
scan.marginPct        → predictions.margin_pct
scan.alternatives     → predictions.alternatives (jsonb)
scan.modelVersion     → predictions.model_version
scan.rejectionReason  → predictions.rejection_reason
```

## Migrating

1. Provision Postgres and apply the schema:

   ```bash
   psql "$DATABASE_URL" -f src/db/schema.sql
   ```

2. Import the JSON store with a one-off script that walks the collections above
   (`users` first, then `farms`, `crop_scans`/`predictions`, then the rest — foreign keys).
3. Replace the body of `src/db/store.mjs` with `pg` queries. Every consumer goes through that
   module's exported functions, so no route, engine, or analytics code changes.
4. Keep `analyticsSnapshot()` as the one place that pulls bulk rows; in Postgres it becomes a set
   of aggregate queries instead of an in-memory scan.

## Backups (JSON era)

`store.json` is the entire database. Back it up with the deploy:

```bash
cp data/store.json "backups/store-$(date +%F-%H%M).json"
```

The PM2 deploy script is the natural place to add this.

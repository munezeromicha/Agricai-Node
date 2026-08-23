-- AGRIC AI — PostgreSQL schema (12 tables from the platform improvement plan).
--
-- The running API uses the JSON file store in `src/db/store.mjs`; collection names
-- and record shapes there mirror these tables one-to-one, so migrating is a driver
-- swap plus a one-off import (see docs/DATABASE.md).
--
--   psql "$DATABASE_URL" -f src/db/schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. farmers -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farmers (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    phone          TEXT,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'farmer' CHECK (role IN ('farmer', 'agronomist', 'superadmin')),
    plan           TEXT NOT NULL DEFAULT 'free'   CHECK (plan IN ('free', 'pro', 'enterprise')),
    language       TEXT NOT NULL DEFAULT 'en',
    district       TEXT,
    sector         TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farmers_district_idx ON farmers (district);

-- 2. farms -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farms (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id   UUID NOT NULL REFERENCES farmers (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    latitude    DOUBLE PRECISION,
    longitude   DOUBLE PRECISION,
    accuracy_m  DOUBLE PRECISION,
    district    TEXT,
    sector      TEXT,
    size_ha     NUMERIC(8, 2),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farms_farmer_idx ON farms (farmer_id);
CREATE INDEX IF NOT EXISTS farms_geo_idx ON farms (latitude, longitude);

-- 3. crops -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crops (
    id         TEXT PRIMARY KEY,               -- 'tomato', 'maize', …
    name_en    TEXT NOT NULL,
    name_rw    TEXT NOT NULL,
    season     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. diseases ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diseases (
    id               TEXT PRIMARY KEY,          -- model class id
    crop_id          TEXT REFERENCES crops (id) ON DELETE SET NULL,
    name_en          TEXT NOT NULL,
    name_rw          TEXT NOT NULL,
    scientific_name  TEXT,
    type             TEXT NOT NULL DEFAULT 'disease' CHECK (type IN ('healthy', 'disease', 'pest', 'unknown')),
    severity         TEXT CHECK (severity IN ('none', 'mild', 'moderate', 'severe')),
    treatment_en     TEXT,
    treatment_rw     TEXT,
    prevention_en    TEXT,
    prevention_rw    TEXT
);
CREATE INDEX IF NOT EXISTS diseases_crop_idx ON diseases (crop_id);

-- 5. crop_scans --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crop_scans (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id      UUID NOT NULL REFERENCES farmers (id) ON DELETE CASCADE,
    farm_id        UUID REFERENCES farms (id) ON DELETE SET NULL,
    crop_id        TEXT REFERENCES crops (id) ON DELETE SET NULL,
    client_id      TEXT,                        -- offline queue idempotency key
    image_url      TEXT,
    latitude       DOUBLE PRECISION,
    longitude      DOUBLE PRECISION,
    accuracy_m     DOUBLE PRECISION,
    location_label TEXT,
    captured_at    TIMESTAMPTZ,                 -- when the photo was taken (may predate sync)
    synced_offline BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (farmer_id, client_id)
);
CREATE INDEX IF NOT EXISTS crop_scans_farmer_created_idx ON crop_scans (farmer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crop_scans_geo_idx ON crop_scans (latitude, longitude);

-- 6. predictions -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS predictions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id           UUID NOT NULL REFERENCES crop_scans (id) ON DELETE CASCADE,
    disease_id        TEXT REFERENCES diseases (id) ON DELETE SET NULL,
    disease_name      TEXT NOT NULL,
    disease_name_rw   TEXT,
    type              TEXT NOT NULL DEFAULT 'unknown',
    confidence        NUMERIC(5, 2) NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    confidence_level  TEXT NOT NULL CHECK (confidence_level IN ('high', 'medium', 'low', 'very_low')),
    margin_pct        NUMERIC(5, 2),
    alternatives      JSONB NOT NULL DEFAULT '[]'::jsonb,
    model_version     TEXT,
    inference_mode    TEXT,
    rejection_reason  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS predictions_scan_idx ON predictions (scan_id);
CREATE INDEX IF NOT EXISTS predictions_disease_idx ON predictions (disease_id);

-- 7. weather -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS weather (
    id            BIGSERIAL PRIMARY KEY,
    latitude      DOUBLE PRECISION NOT NULL,
    longitude     DOUBLE PRECISION NOT NULL,
    observed_at   TIMESTAMPTZ NOT NULL,
    temperature_c NUMERIC(5, 2),
    humidity_pct  NUMERIC(5, 2),
    wind_kph      NUMERIC(5, 2),
    rain_mm       NUMERIC(6, 2),
    weather_code  INTEGER,
    risk_index    NUMERIC(5, 2),                -- 0–100 fungal-disease pressure
    payload       JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS weather_geo_time_idx ON weather (latitude, longitude, observed_at DESC);

-- 8. recommendations ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS recommendations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id    UUID NOT NULL REFERENCES farmers (id) ON DELETE CASCADE,
    scan_id      UUID REFERENCES crop_scans (id) ON DELETE SET NULL,
    crop_id      TEXT REFERENCES crops (id) ON DELETE SET NULL,
    category     TEXT NOT NULL CHECK (category IN ('treatment', 'spray_window', 'irrigation', 'fertilizer', 'monitoring', 'harvest', 'advisory')),
    priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
    title_en     TEXT NOT NULL,
    title_rw     TEXT NOT NULL,
    body_en      TEXT NOT NULL,
    body_rw      TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT 'engine',
    valid_until  TIMESTAMPTZ,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dismissed')),
    completed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recommendations_farmer_idx ON recommendations (farmer_id, created_at DESC);

-- 9. feedback ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id      UUID NOT NULL REFERENCES farmers (id) ON DELETE CASCADE,
    scan_id        UUID REFERENCES crop_scans (id) ON DELETE CASCADE,
    prediction_id  UUID REFERENCES predictions (id) ON DELETE SET NULL,
    verdict        TEXT NOT NULL CHECK (verdict IN ('correct', 'incorrect', 'unsure')),
    actual_disease TEXT,
    rating         SMALLINT CHECK (rating BETWEEN 1 AND 5),
    comment        TEXT,
    reviewed_by    UUID REFERENCES farmers (id) ON DELETE SET NULL,
    reviewed_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (scan_id)
);
CREATE INDEX IF NOT EXISTS feedback_verdict_idx ON feedback (verdict, created_at DESC);

-- 10. payments ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id      UUID NOT NULL REFERENCES farmers (id) ON DELETE CASCADE,
    plan           TEXT NOT NULL,
    amount_cents   INTEGER NOT NULL DEFAULT 0,
    currency       TEXT NOT NULL DEFAULT 'USD',
    provider       TEXT NOT NULL DEFAULT 'stub',   -- stripe | momo | stub
    provider_ref   TEXT,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_farmer_idx ON payments (farmer_id, created_at DESC);

-- 11. agronomists ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agronomists (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id    UUID UNIQUE REFERENCES farmers (id) ON DELETE CASCADE,  -- login account
    full_name    TEXT NOT NULL,
    phone        TEXT,
    district     TEXT,
    specialties  TEXT[] NOT NULL DEFAULT '{}',
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 12. notifications ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id  UUID NOT NULL REFERENCES farmers (id) ON DELETE CASCADE,
    channel    TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'sms', 'push', 'email')),
    category   TEXT NOT NULL DEFAULT 'advisory',
    title_en   TEXT NOT NULL,
    title_rw   TEXT NOT NULL,
    body_en    TEXT NOT NULL,
    body_rw    TEXT NOT NULL,
    read_at    TIMESTAMPTZ,
    sent_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_farmer_idx ON notifications (farmer_id, created_at DESC);

-- Refresh tokens (auth support table, not in the 12 but required by the API) ---
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id  UUID NOT NULL REFERENCES farmers (id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_farmer_idx ON refresh_tokens (farmer_id);

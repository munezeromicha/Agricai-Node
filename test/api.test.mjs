/**
 * End-to-end API test over the real Express app with a throwaway JSON store.
 * No network is required: the weather endpoints are exercised separately and the
 * recommendation endpoint degrades gracefully when the forecast cannot be fetched.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "agricai-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "store.json");
process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-tests-0123456789";
process.env.BCRYPT_ROUNDS = "4";
process.env.SUPERADMIN_EMAIL = "admin@test.local";
process.env.SUPERADMIN_PASSWORD = "admin-password-123";
process.env.FARMER_SCANS_PER_DAY = "10";

const express = (await import("express")).default;
const { mountPlatformApi } = await import("../src/platformApi.mjs");

let server;
let base;

function api(path, { token, method = "GET", body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: "512kb" }));
  mountPlatformApi(app);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  // The SuperAdmin seed is async inside mountPlatformApi.
  await new Promise((r) => setTimeout(r, 300));
});

after(() => {
  server?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("auth", () => {
  let token;

  it("registers a farmer and returns tokens", async () => {
    const res = await api("/api/auth/register", {
      method: "POST",
      body: { name: "Mukamana Alice", email: "alice@farm.rw", password: "strong-pass-123", district: "Musanze" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, "farmer");
    assert.equal(res.body.user.district, "Musanze");
    assert.ok(res.body.accessToken);
    assert.equal(res.body.user.passwordHash, undefined, "password hash must never leave the server");
    token = res.body.accessToken;
  });

  it("rejects a duplicate email", async () => {
    const res = await api("/api/auth/register", {
      method: "POST",
      body: { name: "Copy", email: "alice@farm.rw", password: "strong-pass-123" },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "EMAIL_EXISTS");
  });

  it("rejects weak passwords", async () => {
    const res = await api("/api/auth/register", {
      method: "POST",
      body: { name: "Weak", email: "weak@farm.rw", password: "short" },
    });
    assert.equal(res.status, 400);
  });

  it("gives the same error for a wrong password and an unknown account", async () => {
    const wrongPass = await api("/api/auth/login", { method: "POST", body: { email: "alice@farm.rw", password: "nope" } });
    const unknown = await api("/api/auth/login", { method: "POST", body: { email: "ghost@farm.rw", password: "nope" } });
    assert.equal(wrongPass.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrongPass.body.message, unknown.body.message);
  });

  it("refuses protected routes without a token", async () => {
    const res = await api("/api/auth/me");
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "AUTH_REQUIRED");
  });

  it("returns the profile with usage counters", async () => {
    const res = await api("/api/auth/me", { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, "alice@farm.rw");
    assert.equal(res.body.usage.scansToday, 0);
  });
});

describe("scans, GPS and offline sync", () => {
  let token;
  let scanId;

  before(async () => {
    const res = await api("/api/auth/register", {
      method: "POST",
      body: { name: "Bosco", email: "bosco@farm.rw", password: "strong-pass-123" },
    });
    token = res.body.accessToken;
  });

  it("stores a scan with GPS, crop and a derived confidence band", async () => {
    const res = await api("/api/users/me/scans", {
      token,
      method: "POST",
      body: {
        diseaseName: "Late Blight",
        diseaseNameRw: "Kirabiranya",
        confidence: 93.4,
        marginPct: 40,
        crop: "Tomato",
        type: "disease",
        latitude: -1.4998,
        longitude: 29.6339,
        accuracyM: 12,
        locationLabel: "Musanze",
        clientId: "device-scan-1",
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.scan.confidenceLevel, "high");
    assert.equal(res.body.scan.crop, "tomato", "crop is normalized to lowercase");
    assert.equal(res.body.scan.latitude, -1.4998);
    assert.ok(res.body.scan.confidenceGuidance.rw.length > 10);
    scanId = res.body.scan.id;
  });

  it("is idempotent on clientId so a retried upload cannot duplicate history", async () => {
    const res = await api("/api/users/me/scans", {
      token,
      method: "POST",
      body: { diseaseName: "Late Blight", confidence: 93.4, crop: "tomato", type: "disease", clientId: "device-scan-1" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.duplicate, true);
    assert.equal(res.body.scan.id, scanId);
  });

  it("rejects out-of-range coordinates instead of storing junk", async () => {
    const res = await api("/api/users/me/scans", {
      token,
      method: "POST",
      body: { diseaseName: "X", confidence: 50, latitude: 999, longitude: -999, clientId: "bad-gps" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.scan.latitude, null);
    assert.equal(res.body.scan.longitude, null);
  });

  it("clamps a hostile confidence value", async () => {
    const res = await api("/api/users/me/scans", {
      token,
      method: "POST",
      body: { diseaseName: "X", confidence: 100000, type: "not-a-type", clientId: "bad-conf" },
    });
    assert.equal(res.body.scan.confidence, 0, "out-of-range confidence falls back to 0");
    assert.equal(res.body.scan.type, "unknown", "unknown type values are normalized");
  });

  it("syncs an offline batch, skipping duplicates", async () => {
    const res = await api("/api/users/me/scans/sync", {
      token,
      method: "POST",
      body: {
        scans: [
          { clientId: "offline-1", diseaseName: "Early Blight", confidence: 71, marginPct: 20, crop: "tomato", type: "disease", capturedAt: Date.now() - 3600_000 },
          { clientId: "device-scan-1", diseaseName: "Late Blight", confidence: 93.4, crop: "tomato", type: "disease" },
          { diseaseName: "No client id", confidence: 50 },
        ],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, 1);
    assert.equal(res.body.duplicates, 1);
    assert.equal(res.body.rejected, 1);
    assert.equal(res.body.results[2].reason, "MISSING_CLIENT_ID");
  });

  it("marks synced scans so analytics can measure offline usage", async () => {
    const res = await api("/api/users/me/scans", { token });
    const offline = res.body.scans.find((s) => s.clientId === "offline-1");
    assert.equal(offline.syncedOffline, true);
    assert.equal(offline.confidenceLevel, "medium");
  });

  it("caps an oversized sync batch", async () => {
    const scans = Array.from({ length: 60 }, (_, i) => ({ clientId: `flood-${i}`, diseaseName: "X", confidence: 10 }));
    const res = await api("/api/users/me/scans/sync", { token, method: "POST", body: { scans } });
    assert.equal(res.status, 413);
    assert.equal(res.body.code, "BATCH_TOO_LARGE");
  });

  it("enforces the daily scan limit", async () => {
    let limited = null;
    for (let i = 0; i < 12; i++) {
      const res = await api("/api/users/me/scans", {
        token,
        method: "POST",
        body: { diseaseName: "X", confidence: 60, clientId: `limit-${i}` },
      });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    assert.ok(limited, "expected the scan limit to trigger");
    assert.equal(limited.body.code, "SCAN_LIMIT");
  });
});

describe("feedback", () => {
  let token;
  let otherToken;
  let scanId;

  before(async () => {
    token = (await api("/api/auth/register", { method: "POST", body: { name: "Claudine", email: "claudine@farm.rw", password: "strong-pass-123" } })).body.accessToken;
    otherToken = (await api("/api/auth/register", { method: "POST", body: { name: "Eric", email: "eric@farm.rw", password: "strong-pass-123" } })).body.accessToken;
    const scan = await api("/api/users/me/scans", {
      token,
      method: "POST",
      body: { diseaseName: "Leaf Mold", confidence: 77, marginPct: 25, crop: "tomato", type: "disease", clientId: "fb-scan" },
    });
    scanId = scan.body.scan.id;
  });

  it("records a farmer verdict on a diagnosis", async () => {
    const res = await api(`/api/scans/${scanId}/feedback`, {
      token,
      method: "POST",
      body: { verdict: "correct", rating: 5, comment: "Matched what the agronomist said." },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.feedback.verdict, "correct");
    assert.equal(res.body.feedback.diseaseName, "Leaf Mold");
  });

  it("updates rather than duplicating feedback for the same scan", async () => {
    const res = await api(`/api/scans/${scanId}/feedback`, {
      token,
      method: "POST",
      body: { verdict: "incorrect", actualDisease: "Early Blight" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.updated, true);
    const list = await api("/api/users/me/feedback", { token });
    assert.equal(list.body.feedback.length, 1);
    assert.equal(list.body.feedback[0].actualDisease, "Early Blight");
  });

  it("rejects an invalid verdict", async () => {
    const res = await api(`/api/scans/${scanId}/feedback`, { token, method: "POST", body: { verdict: "maybe" } });
    assert.equal(res.status, 400);
  });

  it("does not let another farmer leave feedback on someone else's scan", async () => {
    const res = await api(`/api/scans/${scanId}/feedback`, { token: otherToken, method: "POST", body: { verdict: "correct" } });
    assert.equal(res.status, 404);
  });

  it("notifies the farmer when a confident disease is detected", async () => {
    const res = await api("/api/notifications", { token });
    assert.ok(res.body.notifications.length >= 1);
    assert.ok(res.body.notifications[0].titleEn.includes("Leaf Mold"));
    assert.equal(res.body.unread >= 1, true);
  });
});

describe("recommendations", () => {
  let token;

  before(async () => {
    token = (await api("/api/auth/register", { method: "POST", body: { name: "Jeanne", email: "jeanne@farm.rw", password: "strong-pass-123" } })).body.accessToken;
    await api("/api/users/me/scans", {
      token,
      method: "POST",
      body: { diseaseName: "Late Blight", confidence: 90, marginPct: 30, crop: "tomato", type: "disease", clientId: "rec-scan" },
    });
  });

  it("returns prioritised, bilingual advice built from the latest scan", async () => {
    const res = await api("/api/recommendations?crop=tomato", { token });
    assert.equal(res.status, 200);
    assert.ok(res.body.recommendations.length > 0);
    const top = res.body.recommendations[0];
    assert.equal(top.category, "treatment");
    assert.ok(top.titleRw.length > 0);
    assert.equal(top.status, "pending");
    assert.ok(top.id);
  });

  it("persists recommendations when asked, and lets a farmer tick one off", async () => {
    const created = await api("/api/recommendations?crop=tomato&persist=true", { token });
    const id = created.body.recommendations[0].id;

    const saved = await api("/api/recommendations/saved", { token });
    assert.ok(saved.body.recommendations.some((r) => r.id === id));

    const done = await api(`/api/recommendations/${id}/complete`, { token, method: "POST", body: { done: true } });
    assert.equal(done.status, 200);
    assert.equal(done.body.recommendation.status, "done");
  });

  it("404s on a recommendation that is not yours", async () => {
    const res = await api("/api/recommendations/not-a-real-id/complete", { token, method: "POST", body: { done: true } });
    assert.equal(res.status, 404);
  });
});

describe("farms", () => {
  let token;

  before(async () => {
    token = (await api("/api/auth/register", { method: "POST", body: { name: "Farm Owner", email: "owner@farm.rw", password: "strong-pass-123" } })).body.accessToken;
  });

  it("saves a farm location and reuses it as the default weather anchor", async () => {
    const res = await api("/api/farms", {
      token,
      method: "POST",
      body: { name: "Home plot", latitude: -1.5, longitude: 29.63, district: "Musanze", sizeHa: 0.4 },
    });
    assert.equal(res.status, 201);

    const list = await api("/api/farms", { token });
    assert.equal(list.body.farms.length, 1);
    assert.equal(list.body.lastLocation.source, "farm");
    assert.equal(list.body.lastLocation.latitude, -1.5);
  });

  it("updates the same farm instead of creating duplicates", async () => {
    await api("/api/farms", { token, method: "POST", body: { name: "Home plot", latitude: -1.51, longitude: 29.64 } });
    const list = await api("/api/farms", { token });
    assert.equal(list.body.farms.length, 1);
    assert.equal(list.body.farms[0].latitude, -1.51);
  });

  it("rejects a farm without valid coordinates", async () => {
    const res = await api("/api/farms", { token, method: "POST", body: { name: "Bad", latitude: "north" } });
    assert.equal(res.status, 400);
  });
});

describe("admin", () => {
  let adminToken;
  let farmerToken;

  before(async () => {
    const login = await api("/api/auth/login", { method: "POST", body: { email: "admin@test.local", password: "admin-password-123" } });
    adminToken = login.body.accessToken;
    farmerToken = (await api("/api/auth/login", { method: "POST", body: { email: "alice@farm.rw", password: "strong-pass-123" } })).body.accessToken;
  });

  it("seeds the SuperAdmin account from the environment", async () => {
    const me = await api("/api/auth/me", { token: adminToken });
    assert.equal(me.body.user.role, "superadmin");
    assert.equal(me.body.features.adminAccess, true);
  });

  it("blocks farmers from admin endpoints", async () => {
    const res = await api("/api/admin/analytics", { token: farmerToken });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "FORBIDDEN");
  });

  it("serves the executive analytics payload", async () => {
    const res = await api("/api/admin/analytics?days=14", { token: adminToken });
    assert.equal(res.status, 200);
    const a = res.body.analytics;
    assert.ok(a.totals.farmers >= 5);
    assert.equal(a.growth.scansSeries.length, 14);
    assert.ok(a.distribution.byCrop.some((c) => c.name === "tomato"));
    assert.ok(a.modelQuality.feedbackCount >= 1);
    assert.equal(typeof a.engagement.activeFarmers7d, "number");
    assert.ok(a.distribution.locatedScanSharePct > 0, "GPS capture should show up in analytics");
  });

  it("lists feedback with the farmer identity attached", async () => {
    const res = await api("/api/admin/feedback", { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.feedback.length >= 1);
    assert.ok(res.body.feedback[0].userEmail.includes("@"));
  });

  it("lists scans across the platform", async () => {
    const res = await api("/api/admin/scans?limit=5", { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.scans.length <= 5);
  });
});

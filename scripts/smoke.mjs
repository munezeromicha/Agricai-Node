/**
 * Live smoke test — boots the real server and walks the farmer journey end to end:
 * register, scan with GPS, offline sync, feedback, notifications, weather intelligence,
 * recommendations, farm location, and the SuperAdmin analytics dashboard.
 *
 *   npm run smoke
 *
 * Runs against a throwaway JSON store (never your real data) on port 3099.
 * The weather check needs internet; everything else is self-contained.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT) || 3099;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(path.join(tmpdir(), "agricai-smoke-"));

const env = {
  ...process.env,
  PORT: String(PORT),
  DATABASE_PATH: path.join(dir, "store.json"),
  JWT_SECRET: "smoke-test-secret-that-is-definitely-long-enough-123456",
  BCRYPT_ROUNDS: "4",
  SUPERADMIN_EMAIL: "ceo@smoke.local",
  SUPERADMIN_PASSWORD: "smoke-admin-password",
  NODE_ENV: "development",
};

const child = spawn(process.execPath, ["src/server.mjs"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => process.stdout.write(`  [server] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`  [server:err] ${d}`));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(p, { token, method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

try {
  if (!(await waitForServer())) throw new Error("server never became healthy");

  const health = await api("/health");
  check("health endpoint responds", health.status === 200 && health.body.ok === true);
  check(
    "security headers present",
    health.headers.get("x-content-type-options") === "nosniff" && health.headers.get("x-frame-options") === "DENY",
  );

  const reg = await api("/api/auth/register", {
    method: "POST",
    body: { name: "Smoke Farmer", email: "smoke@farm.rw", password: "smoke-pass-1234", district: "Musanze" },
  });
  check("farmer registers", reg.status === 201 && Boolean(reg.body.accessToken));
  const token = reg.body.accessToken;

  const scan = await api("/api/users/me/scans", {
    token,
    method: "POST",
    body: {
      clientId: "smoke-1",
      diseaseName: "Late Blight",
      diseaseNameRw: "Kirabiranya",
      confidence: 93.2,
      marginPct: 38,
      crop: "Tomato",
      type: "disease",
      latitude: -1.4998,
      longitude: 29.6339,
      accuracyM: 9,
    },
  });
  check(
    "scan stored with GPS + confidence band",
    scan.status === 201 && scan.body.scan.confidenceLevel === "high" && scan.body.scan.latitude === -1.4998,
    `band=${scan.body.scan?.confidenceLevel}`,
  );

  const dup = await api("/api/users/me/scans", {
    token,
    method: "POST",
    body: { clientId: "smoke-1", diseaseName: "Late Blight", confidence: 93.2 },
  });
  check("duplicate clientId is idempotent", dup.body.duplicate === true && dup.body.scan.id === scan.body.scan.id);

  const sync = await api("/api/users/me/scans/sync", {
    token,
    method: "POST",
    body: {
      scans: [
        { clientId: "smoke-offline-1", diseaseName: "Early Blight", confidence: 72, marginPct: 18, crop: "tomato", type: "disease" },
        { clientId: "smoke-1", diseaseName: "Late Blight", confidence: 93.2 },
      ],
    },
  });
  check("offline batch syncs", sync.body.accepted === 1 && sync.body.duplicates === 1);

  const fb = await api(`/api/scans/${scan.body.scan.id}/feedback`, {
    token,
    method: "POST",
    body: { verdict: "correct", rating: 5, comment: "Matched the field." },
  });
  check("feedback recorded", fb.status === 201 && fb.body.feedback.verdict === "correct");

  const notif = await api("/api/notifications", { token });
  check("disease notification raised", notif.body.notifications.length >= 1, notif.body.notifications[0]?.titleEn);

  const weather = await api("/api/weather/intelligence?lat=-1.4998&lon=29.6339");
  if (weather.status === 200) {
    const i = weather.body.intelligence;
    check(
      "weather intelligence returns risk + spray windows",
      typeof i.riskIndex === "number" && Array.isArray(i.sprayWindows) && i.sprayWindows.length > 0,
      `risk=${i.riskIndex} (${i.riskLevel}), nextSpray=${i.nextGoodSprayDate}`,
    );
  } else {
    check("weather intelligence (needs internet)", false, `status ${weather.status} — upstream unreachable`);
  }

  const recs = await api("/api/recommendations?crop=tomato&persist=true", { token });
  check(
    "recommendation engine produces a prioritised plan",
    recs.status === 200 &&
      recs.body.recommendations.length > 0 &&
      recs.body.recommendations[0].category === "treatment" &&
      ["urgent", "high"].includes(recs.body.recommendations[0].priority),
    `${recs.body.recommendations.length} items, top="${recs.body.recommendations[0]?.titleEn}"`,
  );

  const done = await api(`/api/recommendations/${recs.body.recommendations[0].id}/complete`, {
    token,
    method: "POST",
    body: { done: true },
  });
  check("recommendation can be ticked off", done.body.recommendation?.status === "done");

  const farm = await api("/api/farms", {
    token,
    method: "POST",
    body: { name: "Home plot", latitude: -1.5, longitude: 29.63, district: "Musanze" },
  });
  check("farm location saved", farm.status === 201);

  const adminLogin = await api("/api/auth/login", { method: "POST", body: { email: "ceo@smoke.local", password: "smoke-admin-password" } });
  const adminToken = adminLogin.body.accessToken;
  check("superadmin can log in", Boolean(adminToken));

  const forbidden = await api("/api/admin/analytics", { token });
  check("farmers cannot read analytics", forbidden.status === 403);

  const analytics = await api("/api/admin/analytics?days=30", { token: adminToken });
  const a = analytics.body.analytics;
  check(
    "CEO analytics computed from real records",
    analytics.status === 200 && a.totals.scans === 2 && a.modelQuality.accuracyPct === 100 && a.distribution.locatedScanSharePct === 50,
    `scans=${a?.totals?.scans}, accuracy=${a?.modelQuality?.accuracyPct}%, gps=${a?.distribution?.locatedScanSharePct}%`,
  );

  const badJson = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  const badBody = await badJson.json().catch(() => ({}));
  check("malformed JSON answers in the API envelope", badJson.status === 400 && badBody.ok === false);
} catch (err) {
  check("smoke run completed", false, String(err));
} finally {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

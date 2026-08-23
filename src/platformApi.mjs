import bcrypt from "bcryptjs";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, ok } from "./lib/responses.mjs";
import { signAccessToken, signRefreshToken, verifyToken } from "./lib/jwt.mjs";
import { requireAuth, requireSuperAdmin } from "./middleware/auth.mjs";
import { rateLimit } from "./lib/rateLimit.mjs";
import { confidenceGuidance, confidenceLevel } from "./lib/confidence.mjs";
import { buildWeatherIntelligence } from "./lib/weatherIntelligence.mjs";
import { buildRecommendations } from "./lib/recommendations.mjs";
import { buildAnalytics } from "./lib/analytics.mjs";
import { getForecast, KIGALI } from "./lib/weatherService.mjs";
import * as v from "./lib/validate.mjs";
import {
  addFeedback,
  addNotification,
  addPayment,
  addRecommendations,
  addScan,
  addChatMessage,
  analyticsSnapshot,
  countScansToday,
  countChatsToday,
  createUser,
  deleteUser,
  findFeedbackForScan,
  findRefreshToken,
  findScanByClientId,
  findScanById,
  findUserByEmail,
  findUserById,
  getPlatformStats,
  getSubscription,
  initStore,
  lastKnownLocation,
  listAllFeedback,
  listAllScans,
  listFarmsForUser,
  listFeedbackForUser,
  listNotifications,
  listRecommendationsForUser,
  listScansForUser,
  listUsers,
  markNotificationRead,
  markRecommendationDone,
  publicUser,
  purgeExpiredRefreshTokens,
  saveRefreshToken,
  deleteRefreshToken,
  updateFeedback,
  updateUser,
  upsertFarm,
  upsertSubscription,
} from "./db/store.mjs";
import { roleLimits, FARMER_SCANS_PER_DAY, FARMER_CHATS_PER_DAY } from "./lib/roles.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 12;
const BILLING_STUB_MODE = String(process.env.BILLING_STUB_MODE ?? "true").toLowerCase() === "true";
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_TYPES = ["healthy", "disease", "pest", "unknown"];
const LANGUAGES = ["en", "rw", "sw", "fr", "kg"];
/** Offline queues are capped so one device cannot flood the store in a single call. */
const MAX_SYNC_BATCH = 50;
/** Compared against on unknown emails so login timing does not reveal which accounts exist. */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("agricai-timing-equalizer", 10);

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function resolveCropsPath() {
  const env = process.env.CROPS_JSON_PATH?.trim();
  if (env) return path.resolve(env);
  return path.join(__dirname, "..", "data", "crops.json");
}

let cropsCache = null;
function loadCrops() {
  if (cropsCache) return cropsCache;
  const p = resolveCropsPath();
  if (!existsSync(p)) return [];
  try {
    cropsCache = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    console.error("[crops] Failed to parse crops.json:", err.message);
    cropsCache = [];
  }
  return cropsCache;
}

async function seedSuperAdmin() {
  const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD;
  const name = process.env.SUPERADMIN_NAME?.trim() || "Super Admin";
  if (!email || !password) return;

  if (process.env.NODE_ENV === "production" && password.length < 12) {
    console.error("[auth] SUPERADMIN_PASSWORD is too short for production (min 12 chars) — skipping seed.");
    return;
  }

  const existing = findUserByEmail(email);
  if (existing) {
    if (existing.role !== "superadmin") {
      updateUser(existing.id, { role: "superadmin", plan: "enterprise" });
      console.info(`[auth] Promoted existing user to SuperAdmin: ${email}`);
    }
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  createUser({
    id: randomUUID(),
    email,
    name,
    role: "superadmin",
    plan: "enterprise",
    language: "en",
    passwordHash,
    createdAt: Date.now(),
  });
  console.info(`[auth] SuperAdmin seeded: ${email}`);
}

/**
 * Normalizes one scan payload (live capture or offline replay) into a stored record.
 * Confidence banding happens here so every consumer — history, analytics, exports —
 * reads the same label for the same number.
 */
function buildScanRecord(userId, body, { now = Date.now() } = {}) {
  const confidence = v.num(body?.confidence, { min: 0, max: 100, fallback: 0 });
  const marginPct = v.num(body?.marginPct ?? body?.confidence_margin_pct, { min: 0, max: 100 });
  const level = confidenceLevel(confidence, marginPct);
  const capturedAt = v.timestamp(body?.capturedAt, now) ?? now;

  return {
    id: randomUUID(),
    userId,
    clientId: v.str(body?.clientId, 80) || null,
    diseaseName: v.str(body?.diseaseName, 120) || "Unknown",
    diseaseNameRw: v.str(body?.diseaseNameRw, 120),
    confidence,
    marginPct,
    confidenceLevel: level,
    crop: v.str(body?.crop, 40).toLowerCase(),
    type: v.oneOf(v.str(body?.type, 20), SCAN_TYPES, "unknown"),
    topClassId: v.str(body?.topClassId, 80) || null,
    alternatives: v.alternatives(body?.alternatives),
    modelVersion: v.str(body?.modelVersion, 60) || null,
    inferenceMode: v.str(body?.inferenceMode, 40) || null,
    rejectionReason: v.str(body?.rejectionReason, 40) || null,
    latitude: v.lat(body?.latitude),
    longitude: v.lon(body?.longitude),
    accuracyM: v.num(body?.accuracyM, { min: 0, max: 100000 }),
    locationLabel: v.str(body?.locationLabel, 120) || null,
    district: v.str(body?.district, 80) || null,
    syncedOffline: v.bool(body?.syncedOffline, false),
    capturedAt,
    createdAt: now,
  };
}

function scanResponse(scan) {
  const guidance = confidenceGuidance(scan.confidenceLevel);
  return { ...scan, confidenceGuidance: guidance };
}

/** Notify the farmer in-app when a confident disease result lands. */
function notifyOnDisease(scan) {
  if (scan.type !== "disease" && scan.type !== "pest") return;
  if (scan.confidenceLevel !== "high" && scan.confidenceLevel !== "medium") return;
  addNotification({
    id: randomUUID(),
    userId: scan.userId,
    channel: "in_app",
    category: "diagnosis",
    titleEn: `${scan.diseaseName} detected`,
    titleRw: `${scan.diseaseNameRw || scan.diseaseName} yagaragaye`,
    bodyEn: `Detected at ${Math.round(scan.confidence)}% confidence. Open your recommendations for the treatment plan.`,
    bodyRw: `Byabonetse kuri ${Math.round(scan.confidence)}%. Fungura inama ubone uburyo bwo kuvura.`,
    readAt: null,
    sentAt: Date.now(),
    createdAt: Date.now(),
  });
}

async function intelligenceForUser(user, { lat, lon } = {}) {
  let latitude = lat;
  let longitude = lon;
  if (latitude == null || longitude == null) {
    const known = lastKnownLocation(user.id);
    latitude = known?.latitude ?? KIGALI.lat;
    longitude = known?.longitude ?? KIGALI.lon;
  }
  try {
    const { weather } = await getForecast(latitude, longitude);
    return { weather, intelligence: buildWeatherIntelligence(weather) };
  } catch {
    return { weather: null, intelligence: null };
  }
}

export function mountPlatformApi(app) {
  initStore(process.env.DATABASE_PATH?.trim());
  seedSuperAdmin().catch((err) => console.error("[auth] SuperAdmin seed failed:", err));

  const authLimiter = rateLimit({ name: "auth", windowMs: 15 * 60_000, max: 30 });
  const writeLimiter = rateLimit({ name: "write", windowMs: 60_000, max: 60 });
  const syncLimiter = rateLimit({ name: "sync", windowMs: 60_000, max: 12 });

  // --- Auth ---
  app.post("/api/auth/register", authLimiter, async (req, res) => {
    const name = v.str(req.body?.name, 100);
    const email = v.str(req.body?.email, 255).toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const phone = v.str(req.body?.phone, 30);
    const district = v.str(req.body?.district, 80);

    if (!name) return fail(res, "Name is required");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, "Valid email is required");
    if (!password || password.length < 8) return fail(res, "Password must be at least 8 characters");
    if (password.length > 200) return fail(res, "Password is too long");

    if (findUserByEmail(email)) return fail(res, "Email already registered", 409, { code: "EMAIL_EXISTS" });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = createUser({
      id: randomUUID(),
      email,
      name,
      role: "farmer",
      plan: "free",
      language: "en",
      phone: phone || null,
      district: district || null,
      passwordHash,
      createdAt: Date.now(),
    });

    const accessToken = signAccessToken({ sub: user.id, email: user.email, plan: user.plan });
    const refreshToken = signRefreshToken({ sub: user.id });
    saveRefreshToken({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: Date.now() + REFRESH_TTL_MS,
    });

    return ok(res, { user: publicUser(user), accessToken, refreshToken }, 201);
  });

  app.post("/api/auth/login", authLimiter, async (req, res) => {
    const email = v.str(req.body?.email, 255).toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const user = findUserByEmail(email);
    if (!user) {
      // Constant-ish work regardless of account existence, so timing does not leak emails.
      await bcrypt.compare(password || "x", DUMMY_PASSWORD_HASH);
      return fail(res, "Invalid email or password", 401, { code: "AUTH_INVALID" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return fail(res, "Invalid email or password", 401, { code: "AUTH_INVALID" });

    purgeExpiredRefreshTokens();
    const accessToken = signAccessToken({ sub: user.id, email: user.email, plan: user.plan });
    const refreshToken = signRefreshToken({ sub: user.id });
    saveRefreshToken({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: Date.now() + REFRESH_TTL_MS,
    });

    return ok(res, { user: publicUser(user), accessToken, refreshToken });
  });

  app.post("/api/auth/refresh", authLimiter, (req, res) => {
    const refreshToken = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : "";
    if (!refreshToken) return fail(res, "Refresh token required", 400);

    try {
      const decoded = verifyToken(refreshToken);
      if (decoded.type !== "refresh") return fail(res, "Invalid refresh token", 401);
      const stored = findRefreshToken(hashToken(refreshToken));
      if (!stored || stored.expiresAt < Date.now()) return fail(res, "Refresh token expired", 401);

      const user = findUserById(decoded.sub);
      if (!user) return fail(res, "User not found", 401);

      deleteRefreshToken(hashToken(refreshToken));
      const accessToken = signAccessToken({ sub: user.id, email: user.email, plan: user.plan });
      const newRefresh = signRefreshToken({ sub: user.id });
      saveRefreshToken({
        id: randomUUID(),
        userId: user.id,
        tokenHash: hashToken(newRefresh),
        expiresAt: Date.now() + REFRESH_TTL_MS,
      });

      return ok(res, { accessToken, refreshToken: newRefresh, user: publicUser(user) });
    } catch {
      return fail(res, "Invalid refresh token", 401);
    }
  });

  app.post("/api/auth/logout", requireAuth, (req, res) => {
    const refreshToken = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : "";
    if (refreshToken) deleteRefreshToken(hashToken(refreshToken));
    return ok(res, { loggedOut: true });
  });

  app.get("/api/auth/me", requireAuth, (req, res) => {
    const limits = roleLimits(req.user);
    const scansToday = countScansToday(req.user.id);
    const chatsToday = countChatsToday(req.user.id);
    const sub = getSubscription(req.user.id);
    return ok(res, {
      user: publicUser(req.user),
      usage: {
        scansToday,
        scansLimit: limits.scansPerDay,
        chatsToday,
        chatsLimit: limits.chatsPerDay,
      },
      subscription: sub,
      features: limits,
    });
  });

  // --- Users ---
  app.patch("/api/users/me", requireAuth, (req, res) => {
    const patch = {};
    const name = v.str(req.body?.name, 100);
    if (name) patch.name = name;
    if (LANGUAGES.includes(req.body?.language)) patch.language = req.body.language;
    if (typeof req.body?.phone === "string") patch.phone = v.str(req.body.phone, 30) || null;
    if (typeof req.body?.district === "string") patch.district = v.str(req.body.district, 80) || null;
    const updated = updateUser(req.user.id, patch);
    return ok(res, { user: publicUser(updated) });
  });

  app.get("/api/users/me/scans", requireAuth, (req, res) => {
    const limit = Math.min(v.num(req.query.limit, { min: 1, max: 200, fallback: 50 }), 200);
    const scans = listScansForUser(req.user.id, limit).map(scanResponse);
    return ok(res, { scans });
  });

  app.post("/api/users/me/scans", requireAuth, writeLimiter, (req, res) => {
    const limits = roleLimits(req.user);

    const clientId = v.str(req.body?.clientId, 80);
    if (clientId) {
      const existing = findScanByClientId(req.user.id, clientId);
      if (existing) return ok(res, { scan: scanResponse(existing), duplicate: true }, 200);
    }

    const scansToday = countScansToday(req.user.id);
    if (scansToday >= limits.scansPerDay) {
      return fail(res, `Daily scan limit reached. You can scan up to ${limits.scansPerDay} crops per day.`, 429, {
        code: "SCAN_LIMIT",
        scansToday,
        scansLimit: limits.scansPerDay,
      });
    }

    const scan = addScan(buildScanRecord(req.user.id, req.body));
    notifyOnDisease(scan);

    return ok(res, { scan: scanResponse(scan), scansToday: scansToday + 1 }, 201);
  });

  /**
   * Offline sync — replays scans captured without a network.
   * Idempotent per `clientId`, so a retried batch never duplicates history.
   */
  app.post("/api/users/me/scans/sync", requireAuth, syncLimiter, (req, res) => {
    const items = Array.isArray(req.body?.scans) ? req.body.scans : null;
    if (!items) return fail(res, "Expected a scans array");
    if (items.length > MAX_SYNC_BATCH) {
      return fail(res, `Too many scans in one batch (max ${MAX_SYNC_BATCH}).`, 413, { code: "BATCH_TOO_LARGE" });
    }

    const limits = roleLimits(req.user);
    const results = [];
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;

    for (const item of items) {
      const clientId = v.str(item?.clientId, 80);
      if (!clientId) {
        rejected += 1;
        results.push({ clientId: null, status: "rejected", reason: "MISSING_CLIENT_ID" });
        continue;
      }

      const existing = findScanByClientId(req.user.id, clientId);
      if (existing) {
        duplicates += 1;
        results.push({ clientId, status: "duplicate", scanId: existing.id });
        continue;
      }

      const scansToday = countScansToday(req.user.id);
      if (scansToday >= limits.scansPerDay) {
        rejected += 1;
        results.push({ clientId, status: "rejected", reason: "SCAN_LIMIT" });
        continue;
      }

      // No notification here: the farmer already saw this diagnosis on the device when
      // it was captured — replaying the backlog must not fire a burst of alerts.
      const scan = addScan(buildScanRecord(req.user.id, { ...item, syncedOffline: true }));
      accepted += 1;
      results.push({ clientId, status: "accepted", scanId: scan.id });
    }

    return ok(res, {
      accepted,
      duplicates,
      rejected,
      results,
      scansToday: countScansToday(req.user.id),
      scansLimit: limits.scansPerDay,
    });
  });

  app.get("/api/users/me/usage", requireAuth, (req, res) => {
    const limits = roleLimits(req.user);
    return ok(res, {
      scansToday: countScansToday(req.user.id),
      scansLimit: limits.scansPerDay,
      chatsToday: countChatsToday(req.user.id),
      chatsLimit: limits.chatsPerDay,
      features: limits,
    });
  });

  app.post("/api/users/me/chats", requireAuth, writeLimiter, (req, res) => {
    const limits = roleLimits(req.user);
    const chatsToday = countChatsToday(req.user.id);
    if (chatsToday >= limits.chatsPerDay) {
      return fail(res, "Daily chat limit reached. You can send up to 10 messages per day.", 429, {
        code: "CHAT_LIMIT",
        chatsToday,
        chatsLimit: limits.chatsPerDay,
      });
    }
    const record = addChatMessage({
      id: randomUUID(),
      userId: req.user.id,
      preview: v.str(req.body?.preview, 120),
      createdAt: Date.now(),
    });
    return ok(res, { chat: record, chatsToday: chatsToday + 1 }, 201);
  });

  // --- Farms (GPS anchor for weather + surveillance) ---
  app.get("/api/farms", requireAuth, (req, res) => {
    return ok(res, { farms: listFarmsForUser(req.user.id), lastLocation: lastKnownLocation(req.user.id) });
  });

  app.post("/api/farms", requireAuth, writeLimiter, (req, res) => {
    const name = v.str(req.body?.name, 80) || "My farm";
    const latitude = v.lat(req.body?.latitude);
    const longitude = v.lon(req.body?.longitude);
    if (latitude === null || longitude === null) {
      return fail(res, "Valid latitude and longitude are required");
    }
    const existing = listFarmsForUser(req.user.id).find((f) => f.name === name);
    const farm = upsertFarm({
      id: existing?.id ?? randomUUID(),
      userId: req.user.id,
      name,
      latitude,
      longitude,
      accuracyM: v.num(req.body?.accuracyM, { min: 0, max: 100000 }),
      district: v.str(req.body?.district, 80) || null,
      sector: v.str(req.body?.sector, 80) || null,
      sizeHa: v.num(req.body?.sizeHa, { min: 0, max: 100000 }),
      createdAt: existing?.createdAt ?? Date.now(),
    });
    return ok(res, { farm }, existing ? 200 : 201);
  });

  // --- Feedback (farmer verification of every diagnosis) ---
  app.post("/api/scans/:id/feedback", requireAuth, writeLimiter, (req, res) => {
    const scan = findScanById(req.params.id);
    if (!scan) return fail(res, "Scan not found", 404);
    if (scan.userId !== req.user.id) return fail(res, "Scan not found", 404);

    const verdict = v.oneOf(v.str(req.body?.verdict, 20), ["correct", "incorrect", "unsure"], null);
    if (!verdict) return fail(res, "Verdict must be correct, incorrect, or unsure");

    const record = {
      userId: req.user.id,
      scanId: scan.id,
      verdict,
      actualDisease: v.str(req.body?.actualDisease, 120) || null,
      rating: v.num(req.body?.rating, { min: 1, max: 5 }),
      comment: v.str(req.body?.comment, 1000) || null,
      diseaseName: scan.diseaseName,
      crop: scan.crop,
      confidence: scan.confidence,
      confidenceLevel: scan.confidenceLevel,
      createdAt: Date.now(),
    };

    const existing = findFeedbackForScan(scan.id);
    if (existing) {
      const updated = updateFeedback(existing.id, { ...record, createdAt: existing.createdAt, updatedAt: Date.now() });
      return ok(res, { feedback: updated, updated: true });
    }

    const saved = addFeedback({ id: randomUUID(), ...record });
    return ok(res, { feedback: saved }, 201);
  });

  app.get("/api/users/me/feedback", requireAuth, (req, res) => {
    return ok(res, { feedback: listFeedbackForUser(req.user.id) });
  });

  app.get("/api/admin/feedback", requireSuperAdmin, (req, res) => {
    const limit = Math.min(v.num(req.query.limit, { min: 1, max: 500, fallback: 200 }), 500);
    const feedback = listAllFeedback(limit).map((f) => {
      const owner = findUserById(f.userId);
      return { ...f, userName: owner?.name ?? "Unknown", userEmail: owner?.email ?? "" };
    });
    return ok(res, { feedback });
  });

  // --- Recommendations ---
  app.get("/api/recommendations", requireAuth, async (req, res) => {
    const crop = v.str(req.query.crop, 40).toLowerCase() || null;
    const latitude = v.lat(req.query.lat);
    const longitude = v.lon(req.query.lon);

    const scans = listScansForUser(req.user.id, 50);
    const { weather, intelligence } = await intelligenceForUser(req.user, { lat: latitude, lon: longitude });

    const drafts = buildRecommendations({ scans, intelligence, crop });
    const now = Date.now();
    const recommendations = drafts.map((d) => ({
      id: randomUUID(),
      userId: req.user.id,
      status: "pending",
      source: "engine",
      createdAt: now,
      ...d,
    }));

    // Persist so the farmer can tick them off and analytics can measure follow-through.
    if (v.bool(req.query.persist, false)) addRecommendations(recommendations);

    return ok(res, {
      recommendations,
      weather: weather ? { current: weather.current, latitude: weather.latitude, longitude: weather.longitude } : null,
      intelligence,
    });
  });

  app.get("/api/recommendations/saved", requireAuth, (req, res) => {
    return ok(res, { recommendations: listRecommendationsForUser(req.user.id) });
  });

  app.post("/api/recommendations/:id/complete", requireAuth, writeLimiter, (req, res) => {
    const done = v.bool(req.body?.done, true);
    const updated = markRecommendationDone(req.user.id, req.params.id, done);
    if (!updated) return fail(res, "Recommendation not found", 404);
    return ok(res, { recommendation: updated });
  });

  // --- Notifications ---
  app.get("/api/notifications", requireAuth, (req, res) => {
    const items = listNotifications(req.user.id);
    return ok(res, { notifications: items, unread: items.filter((n) => !n.readAt).length });
  });

  app.post("/api/notifications/:id/read", requireAuth, (req, res) => {
    const updated = markNotificationRead(req.user.id, req.params.id);
    if (!updated) return fail(res, "Notification not found", 404);
    return ok(res, { notification: updated });
  });

  // --- SuperAdmin ---
  app.get("/api/admin/stats", requireSuperAdmin, (_req, res) => {
    return ok(res, { stats: getPlatformStats() });
  });

  app.get("/api/admin/analytics", requireSuperAdmin, (req, res) => {
    const days = Math.min(v.num(req.query.days, { min: 7, max: 90, fallback: 30 }), 90);
    return ok(res, { analytics: buildAnalytics(analyticsSnapshot(), { days }) });
  });

  app.get("/api/admin/users", requireSuperAdmin, (_req, res) => {
    const users = listUsers().map(publicUser);
    return ok(res, { users });
  });

  app.patch("/api/admin/users/:id", requireSuperAdmin, (req, res) => {
    const target = findUserById(req.params.id);
    if (!target) return fail(res, "User not found", 404);
    if (target.id === req.user.id && req.body?.role && req.body.role !== "superadmin") {
      return fail(res, "Cannot demote your own SuperAdmin account", 400);
    }
    const patch = {};
    const name = v.str(req.body?.name, 100);
    if (name) patch.name = name;
    if (req.body?.role === "superadmin" || req.body?.role === "farmer") {
      patch.role = req.body.role;
    }
    const updated = updateUser(target.id, patch);
    return ok(res, { user: publicUser(updated) });
  });

  app.delete("/api/admin/users/:id", requireSuperAdmin, (req, res) => {
    const target = findUserById(req.params.id);
    if (!target) return fail(res, "User not found", 404);
    if (target.id === req.user.id) return fail(res, "Cannot delete your own account", 400);
    deleteUser(target.id);
    return ok(res, { deleted: true });
  });

  app.get("/api/admin/scans", requireSuperAdmin, (req, res) => {
    const limit = Math.min(v.num(req.query.limit, { min: 1, max: 500, fallback: 100 }), 500);
    const scans = listAllScans(limit).map((s) => {
      const owner = findUserById(s.userId);
      return { ...s, userName: owner?.name ?? "Unknown", userEmail: owner?.email ?? "" };
    });
    return ok(res, { scans });
  });

  // --- Weather ---
  app.get("/api/weather", async (req, res) => {
    const lat = v.lat(req.query.lat) ?? KIGALI.lat;
    const lon = v.lon(req.query.lon) ?? KIGALI.lon;
    try {
      const { weather, cached, stale } = await getForecast(lat, lon);
      return ok(res, { weather, cached: Boolean(cached), stale: Boolean(stale) });
    } catch {
      return fail(res, "Weather data unavailable", 502, { code: "WEATHER_UNAVAILABLE" });
    }
  });

  /** Weather turned into decisions: disease pressure, spray windows, advisories. */
  app.get("/api/weather/intelligence", async (req, res) => {
    const lat = v.lat(req.query.lat) ?? KIGALI.lat;
    const lon = v.lon(req.query.lon) ?? KIGALI.lon;
    try {
      const { weather, cached, stale } = await getForecast(lat, lon);
      return ok(res, {
        weather,
        intelligence: buildWeatherIntelligence(weather),
        cached: Boolean(cached),
        stale: Boolean(stale),
      });
    } catch {
      return fail(res, "Weather data unavailable", 502, { code: "WEATHER_UNAVAILABLE" });
    }
  });

  // --- Crops ---
  app.get("/api/crops", (_req, res) => {
    const crops = loadCrops();
    return ok(res, {
      crops: crops.map((c) => ({
        slug: c.slug,
        nameEn: c.nameEn,
        nameRw: c.nameRw,
        diseaseCount: c.diseaseCount,
      })),
    });
  });

  app.get("/api/crops/:slug", (req, res) => {
    const crop = loadCrops().find((c) => c.slug === req.params.slug);
    if (!crop) return fail(res, "Crop not found", 404);
    return ok(res, { crop });
  });

  // --- Billing ---
  app.get("/api/billing/plans", (_req, res) => {
    return ok(res, {
      plans: [
        {
          id: "free",
          nameEn: "Free",
          nameRw: "Ubuntu",
          priceMonthly: 0,
          features: { scansPerDay: FARMER_SCANS_PER_DAY, chatsPerDay: FARMER_CHATS_PER_DAY, pdfExport: true, chatbot: true },
        },
        {
          id: "pro",
          nameEn: "Pro Farmer",
          nameRw: "Umuhinzi w'Umwuga",
          priceMonthly: 4.99,
          featured: true,
          features: { scansPerDay: null, pdfExport: true, chatbot: true },
        },
        {
          id: "enterprise",
          nameEn: "Enterprise",
          nameRw: "Ikigo",
          priceMonthly: null,
          features: { scansPerDay: null, pdfExport: true, chatbot: true, bulkScanning: true },
        },
      ],
    });
  });

  app.get("/api/billing/subscription", requireAuth, (req, res) => {
    const sub = getSubscription(req.user.id);
    return ok(res, {
      plan: req.user.plan,
      subscription: sub,
      features: roleLimits(req.user),
    });
  });

  app.post("/api/billing/checkout", requireAuth, writeLimiter, (req, res) => {
    const plan = req.body?.plan === "pro" ? "pro" : req.body?.plan === "enterprise" ? "enterprise" : null;
    if (!plan) return fail(res, "Invalid plan. Use pro or enterprise.");

    if (BILLING_STUB_MODE || !process.env.STRIPE_SECRET_KEY?.trim()) {
      if (plan === "pro") {
        updateUser(req.user.id, { plan: "pro" });
        upsertSubscription({
          userId: req.user.id,
          plan: "pro",
          status: "active",
          stub: true,
          updatedAt: Date.now(),
        });
        addPayment({
          id: randomUUID(),
          userId: req.user.id,
          plan: "pro",
          amountCents: 0,
          currency: "USD",
          provider: "stub",
          providerRef: null,
          status: "paid",
          createdAt: Date.now(),
        });
      }
      return ok(res, {
        stub: true,
        message: plan === "enterprise"
          ? "Enterprise checkout requires sales contact. Email contact@agric-ai.com."
          : "Pro plan activated (stub mode). Configure STRIPE_SECRET_KEY for live payments.",
        plan: plan === "pro" ? "pro" : req.user.plan,
        url: plan === "enterprise" ? "/contact" : "/dashboard",
      });
    }

    return ok(res, {
      stub: false,
      message: "Stripe checkout session creation — configure STRIPE_PRICE_PRO_MONTHLY in .env",
      url: null,
    });
  });

  // --- OpenAPI ---
  app.get("/api/openapi.json", (_req, res) => {
    const specPath = path.join(__dirname, "..", "docs", "openapi.json");
    if (!existsSync(specPath)) return fail(res, "OpenAPI spec not found", 404);
    res.type("application/json").send(readFileSync(specPath, "utf8"));
  });

  app.get("/api/docs", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html><head><title>AGRIC AI API Docs</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head><body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui' });</script>
</body></html>`);
  });
}

export { buildScanRecord };

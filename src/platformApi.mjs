import bcrypt from "bcryptjs";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, ok } from "./lib/responses.mjs";
import { signAccessToken, signRefreshToken, verifyToken } from "./lib/jwt.mjs";
import { requireAuth } from "./middleware/auth.mjs";
import {
  addScan,
  countScansToday,
  createUser,
  findRefreshToken,
  findUserByEmail,
  findUserById,
  getSubscription,
  initStore,
  listScansForUser,
  publicUser,
  purgeExpiredRefreshTokens,
  saveRefreshToken,
  deleteRefreshToken,
  updateUser,
  upsertSubscription,
} from "./db/store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 12;
const FREE_SCANS_PER_DAY = Number(process.env.FREE_SCANS_PER_DAY) || 5;
const BILLING_STUB_MODE = String(process.env.BILLING_STUB_MODE ?? "true").toLowerCase() === "true";
const OPEN_METEO_BASE = process.env.OPEN_METEO_BASE?.trim() || "https://api.open-meteo.com/v1/forecast";
const WEATHER_CACHE_TTL_MS = (Number(process.env.WEATHER_CACHE_TTL_SEC) || 900) * 1000;

const weatherCache = new Map();

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function resolveCropsPath() {
  const env = process.env.CROPS_JSON_PATH?.trim();
  if (env) return path.resolve(env);
  return path.join(__dirname, "..", "data", "crops.json");
}

function loadCrops() {
  const p = resolveCropsPath();
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8"));
}

function planLimits(plan) {
  if (plan === "pro" || plan === "enterprise") return { scansPerDay: Infinity, pdfExport: true, chatbot: true };
  return { scansPerDay: FREE_SCANS_PER_DAY, pdfExport: false, chatbot: false };
}

export function mountPlatformApi(app) {
  initStore(process.env.DATABASE_PATH?.trim());

  // --- Auth ---
  app.post("/api/auth/register", async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const role = ["farmer", "restaurant", "enterprise"].includes(req.body?.role) ? req.body.role : "farmer";

    if (!name || name.length > 100) return fail(res, "Name is required");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, "Valid email is required");
    if (!password || password.length < 8) return fail(res, "Password must be at least 8 characters");

    if (findUserByEmail(email)) return fail(res, "Email already registered", 409, { code: "EMAIL_EXISTS" });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = createUser({
      id: randomUUID(),
      email,
      name,
      role,
      plan: "free",
      language: "en",
      passwordHash,
      createdAt: Date.now(),
    });

    const accessToken = signAccessToken({ sub: user.id, email: user.email, plan: user.plan });
    const refreshToken = signRefreshToken({ sub: user.id });
    saveRefreshToken({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    return ok(res, { user: publicUser(user), accessToken, refreshToken }, 201);
  });

  app.post("/api/auth/login", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const user = findUserByEmail(email);
    if (!user) return fail(res, "Invalid email or password", 401, { code: "AUTH_INVALID" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return fail(res, "Invalid email or password", 401, { code: "AUTH_INVALID" });

    purgeExpiredRefreshTokens();
    const accessToken = signAccessToken({ sub: user.id, email: user.email, plan: user.plan });
    const refreshToken = signRefreshToken({ sub: user.id });
    saveRefreshToken({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    return ok(res, { user: publicUser(user), accessToken, refreshToken });
  });

  app.post("/api/auth/refresh", (req, res) => {
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
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      return ok(res, { accessToken, refreshToken: newRefresh, user: publicUser(user) });
    } catch {
      return fail(res, "Invalid refresh token", 401);
    }
  });

  app.get("/api/auth/me", requireAuth, (req, res) => {
    const limits = planLimits(req.user.plan);
    const scansToday = countScansToday(req.user.id);
    const sub = getSubscription(req.user.id);
    return ok(res, {
      user: publicUser(req.user),
      usage: { scansToday, scansLimit: limits.scansPerDay },
      subscription: sub,
      features: limits,
    });
  });

  // --- Users ---
  app.patch("/api/users/me", requireAuth, (req, res) => {
    const patch = {};
    if (typeof req.body?.name === "string" && req.body.name.trim()) patch.name = req.body.name.trim().slice(0, 100);
    if (["en", "rw", "sw", "fr", "kg"].includes(req.body?.language)) patch.language = req.body.language;
    const updated = updateUser(req.user.id, patch);
    return ok(res, { user: publicUser(updated) });
  });

  app.get("/api/users/me/scans", requireAuth, (req, res) => {
    return ok(res, { scans: listScansForUser(req.user.id) });
  });

  app.post("/api/users/me/scans", requireAuth, (req, res) => {
    const limits = planLimits(req.user.plan);
    const scansToday = countScansToday(req.user.id);
    if (scansToday >= limits.scansPerDay) {
      return fail(res, "Daily scan limit reached. Upgrade to Pro for unlimited scans.", 429, {
        code: "SCAN_LIMIT",
        scansToday,
        scansLimit: limits.scansPerDay,
      });
    }

    const scan = addScan({
      id: randomUUID(),
      userId: req.user.id,
      diseaseName: req.body?.diseaseName ?? "Unknown",
      diseaseNameRw: req.body?.diseaseNameRw ?? "",
      confidence: Number(req.body?.confidence) || 0,
      crop: req.body?.crop ?? "",
      type: req.body?.type ?? "unknown",
      createdAt: Date.now(),
    });

    return ok(res, { scan, scansToday: scansToday + 1 }, 201);
  });

  app.get("/api/users/me/usage", requireAuth, (req, res) => {
    const limits = planLimits(req.user.plan);
    return ok(res, {
      scansToday: countScansToday(req.user.id),
      scansLimit: limits.scansPerDay,
      features: limits,
    });
  });

  // --- Weather proxy ---
  app.get("/api/weather", async (req, res) => {
    const lat = Number(req.query.lat) || -1.9403;
    const lon = Number(req.query.lon) || 30.0588;
    const cacheKey = `${lat},${lon}`;
    const cached = weatherCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return ok(res, { weather: cached.data, cached: true });
    }

    try {
      const params = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        current: "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
        daily: "weather_code,temperature_2m_max,temperature_2m_min",
        timezone: "Africa/Kigali",
        forecast_days: "7",
      });
      const upstream = await fetch(`${OPEN_METEO_BASE}?${params}`);
      if (!upstream.ok) throw new Error("Weather upstream failed");
      const data = await upstream.json();
      const weather = {
        latitude: lat,
        longitude: lon,
        current: {
          temperature: data.current.temperature_2m,
          humidity: data.current.relative_humidity_2m,
          windSpeed: data.current.wind_speed_10m,
          weatherCode: data.current.weather_code,
          time: data.current.time,
        },
        daily: data.daily.time.map((date, i) => ({
          date,
          maxTemp: data.daily.temperature_2m_max[i],
          minTemp: data.daily.temperature_2m_min[i],
          weatherCode: data.daily.weather_code[i],
        })),
      };
      weatherCache.set(cacheKey, { data: weather, expiresAt: Date.now() + WEATHER_CACHE_TTL_MS });
      return ok(res, { weather });
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
          features: { scansPerDay: FREE_SCANS_PER_DAY, pdfExport: false, chatbot: false },
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
      features: planLimits(req.user.plan),
    });
  });

  app.post("/api/billing/checkout", requireAuth, (req, res) => {
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

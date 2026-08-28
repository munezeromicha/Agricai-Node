import jwt from "jsonwebtoken";

const DEV_SECRET = "agricai-dev-secret-change-in-production";
const PLACEHOLDERS = new Set([DEV_SECRET, "change-me-in-production", "changeme", "secret"]);
const MIN_LENGTH = 32;

/**
 * Every value is read at call time, never at import time.
 *
 * Reading `process.env` while this module is being imported is what caused a
 * production outage: ESM evaluates imports before the entry point's `dotenv.config()`,
 * so the environment was still empty and the dev key was captured as the signing
 * secret. `src/loadEnv.mjs` fixes the ordering; reading lazily makes the ordering
 * impossible to get wrong again.
 */
function configuredSecret() {
  return process.env.JWT_SECRET?.trim() || "";
}

/** @returns {string|null} a human-readable problem, or null when the secret is acceptable. */
export function jwtSecretProblem(secret = configuredSecret(), nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv !== "production") return null;
  if (!secret) return "JWT_SECRET is not set";
  if (PLACEHOLDERS.has(secret)) return "JWT_SECRET is still the example placeholder";
  if (secret.length < MIN_LENGTH) return `JWT_SECRET is only ${secret.length} characters (minimum ${MIN_LENGTH})`;
  return null;
}

function guardBanner(problem) {
  return [
    "",
    "══════════════════════════════════════════════════════════════════",
    "  AGRIC AI API cannot start: insecure JWT_SECRET",
    "══════════════════════════════════════════════════════════════════",
    `  Problem: ${problem}.`,
    "",
    "  Fix it on this server:",
    "    1. Generate a key:",
    '       node -e "console.log(require(\'node:crypto\').randomBytes(48).toString(\'hex\'))"',
    "    2. Put it in Agricai-Node/.env as JWT_SECRET=<the value>",
    "    3. Restart:  pm2 start ecosystem.config.cjs --update-env",
    "",
    "  If .env already has a good value and you still see this, the environment was not",
    "  loaded before this check — confirm src/server.mjs imports ./loadEnv.mjs first.",
    "",
    "  Note: changing JWT_SECRET signs everyone out — they log in again, no data is lost.",
    "  Check the whole environment with:  npm run doctor",
    "══════════════════════════════════════════════════════════════════",
    "",
  ].join("\n");
}

/**
 * Called by the entry point after the environment is loaded. Exits with a readable
 * banner rather than an unhandled exception, because this failure is read in a PM2
 * log by someone whose site is down.
 */
export function assertJwtSecretOrExit() {
  const problem = jwtSecretProblem();
  if (!problem) return;
  console.error(guardBanner(problem));
  process.exit(1);
}

/**
 * Backstop: even if the startup assertion is somehow skipped, production must never
 * sign a token with the development key.
 */
function activeSecret() {
  const problem = jwtSecretProblem();
  if (problem) throw new Error(`Refusing to sign or verify tokens: ${problem}.`);
  return configuredSecret() || DEV_SECRET;
}

function accessTtl() {
  return process.env.JWT_ACCESS_TTL?.trim() || "15m";
}

function refreshTtl() {
  return process.env.JWT_REFRESH_TTL?.trim() || "7d";
}

export function signAccessToken(payload) {
  return jwt.sign(payload, activeSecret(), { expiresIn: accessTtl() });
}

export function signRefreshToken(payload) {
  return jwt.sign({ ...payload, type: "refresh" }, activeSecret(), { expiresIn: refreshTtl() });
}

export function verifyToken(token) {
  return jwt.verify(token, activeSecret());
}

export { DEV_SECRET, MIN_LENGTH as JWT_SECRET_MIN_LENGTH };

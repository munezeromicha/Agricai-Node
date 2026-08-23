import jwt from "jsonwebtoken";

const DEV_SECRET = "agricai-dev-secret-change-in-production";
const PLACEHOLDERS = new Set([DEV_SECRET, "change-me-in-production", "changeme", "secret"]);
const MIN_LENGTH = 32;

const configured = process.env.JWT_SECRET?.trim();

export function jwtSecretProblem(secret = configured, nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv !== "production") return null;
  if (!secret) return "JWT_SECRET is not set";
  if (PLACEHOLDERS.has(secret)) return "JWT_SECRET is still the example placeholder";
  if (secret.length < MIN_LENGTH) return `JWT_SECRET is only ${secret.length} characters (minimum ${MIN_LENGTH})`;
  return null;
}

/**
 * A guessable signing key in production lets anyone mint a SuperAdmin token, so the
 * process refuses to start. The message is printed plainly because this failure is
 * seen by whoever is deploying, in a PM2 log, usually while a site is down.
 */
const problem = jwtSecretProblem();
if (problem) {
  console.error(
    [
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
      "    3. Restart:  pm2 restart Agricai-Node",
      "",
      "  Note: changing JWT_SECRET signs everyone out — they log in again, no data is lost.",
      "  Check the whole environment first with:  npm run doctor",
      "══════════════════════════════════════════════════════════════════",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const JWT_SECRET = configured || DEV_SECRET;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL?.trim() || "15m";
const REFRESH_TTL = process.env.JWT_REFRESH_TTL?.trim() || "7d";

if (!configured && process.env.NODE_ENV !== "test") {
  console.warn("[auth] JWT_SECRET is not set — using the development key. Never do this in production.");
}

export function signAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TTL });
}

export function signRefreshToken(payload) {
  return jwt.sign({ ...payload, type: "refresh" }, JWT_SECRET, { expiresIn: REFRESH_TTL });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export { JWT_SECRET, MIN_LENGTH as JWT_SECRET_MIN_LENGTH };

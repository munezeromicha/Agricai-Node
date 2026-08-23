import jwt from "jsonwebtoken";

const DEV_SECRET = "agricai-dev-secret-change-in-production";
const configured = process.env.JWT_SECRET?.trim();

/**
 * A default signing key in production would let anyone mint admin tokens, so the
 * process refuses to start without a real one.
 */
if (process.env.NODE_ENV === "production" && (!configured || configured === DEV_SECRET || configured === "change-me-in-production" || configured.length < 32)) {
  throw new Error(
    "JWT_SECRET must be set to a unique value of at least 32 characters in production. " +
      "Generate one with: node -e \"console.log(require('node:crypto').randomBytes(48).toString('hex'))\"",
  );
}

const JWT_SECRET = configured || DEV_SECRET;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL?.trim() || "15m";
const REFRESH_TTL = process.env.JWT_REFRESH_TTL?.trim() || "7d";

export function signAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TTL });
}

export function signRefreshToken(payload) {
  return jwt.sign({ ...payload, type: "refresh" }, JWT_SECRET, { expiresIn: REFRESH_TTL });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export { JWT_SECRET };

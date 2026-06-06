import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET?.trim() || "agricai-dev-secret-change-in-production";
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

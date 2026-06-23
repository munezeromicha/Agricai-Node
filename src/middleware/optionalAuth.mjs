import { verifyToken } from "../lib/jwt.mjs";
import { findUserById } from "../db/store.mjs";

/** Attaches req.user when a valid Bearer access token is present; otherwise continues. */
export function optionalAuth(req, _res, next) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    next();
    return;
  }
  try {
    const decoded = verifyToken(token);
    if (decoded.type === "refresh") {
      next();
      return;
    }
    const user = findUserById(decoded.sub);
    if (user) req.user = user;
  } catch {
    /* ignore invalid token for optional auth */
  }
  next();
}

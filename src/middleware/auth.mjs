import { verifyToken } from "../lib/jwt.mjs";
import { fail } from "../lib/responses.mjs";
import { findUserById } from "../db/store.mjs";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return fail(res, "Authentication required", 401, { code: "AUTH_REQUIRED" });

  try {
    const decoded = verifyToken(token);
    if (decoded.type === "refresh") return fail(res, "Invalid token type", 401, { code: "AUTH_INVALID" });
    const user = findUserById(decoded.sub);
    if (!user) return fail(res, "User not found", 401, { code: "AUTH_INVALID" });
    req.user = user;
    next();
  } catch {
    return fail(res, "Invalid or expired token", 401, { code: "AUTH_INVALID" });
  }
}

export function requireSuperAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user?.role !== "superadmin") {
      return fail(res, "SuperAdmin access required", 403, { code: "FORBIDDEN" });
    }
    next();
  });
}

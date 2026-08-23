/**
 * Minimal in-memory rate limiter (fixed window per key).
 *
 * Enough for a single-process pilot deployment: it stops credential stuffing and
 * runaway offline-sync loops without adding Redis. Swap for a shared store when the
 * API scales past one instance.
 */

const buckets = new Map();

function clientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "") || req.ip || req.socket?.remoteAddress || "unknown";
  return req.user?.id ? `u:${req.user.id}` : `ip:${ip}`;
}

/**
 * @param {object} opts
 * @param {number} opts.windowMs
 * @param {number} opts.max requests allowed per window
 * @param {string} opts.name bucket namespace
 */
export function rateLimit({ windowMs = 60_000, max = 60, name = "default" } = {}) {
  return function limiter(req, res, next) {
    const key = `${name}:${clientKey(req)}`;
    const now = Date.now();
    const entry = buckets.get(key);

    if (!entry || entry.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        ok: false,
        code: "RATE_LIMITED",
        message: `Too many requests. Try again in ${retryAfter}s.`,
      });
      return;
    }
    next();
  };
}

/** Periodic cleanup so the map cannot grow unbounded. */
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
sweep.unref?.();

/** Test helper. */
export function resetRateLimits() {
  buckets.clear();
}

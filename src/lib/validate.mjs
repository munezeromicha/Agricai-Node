/** Small input coercion helpers shared by the platform endpoints. */

export function str(value, maxLen = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

export function num(value, { min = -Infinity, max = Infinity, fallback = null } = {}) {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

export function lat(value) {
  return num(value, { min: -90, max: 90 });
}

export function lon(value) {
  return num(value, { min: -180, max: 180 });
}

export function bool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/** Epoch ms that is neither in the future nor absurdly old (guards offline sync payloads). */
export function timestamp(value, now = Date.now()) {
  const n = num(value, { min: 0, max: now + 5 * 60_000 });
  if (n === null) return null;
  if (now - n > 365 * 24 * 60 * 60 * 1000) return null;
  return n;
}

export function oneOf(value, allowed, fallback = null) {
  return allowed.includes(value) ? value : fallback;
}

/** Alternatives array from the vision API: [{class_id, disease_name, confidence}] */
export function alternatives(value, limit = 5) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((a) => a && typeof a === "object")
    .slice(0, limit)
    .map((a) => ({
      classId: str(a.class_id ?? a.classId, 80),
      diseaseName: str(a.disease_name ?? a.diseaseName, 120),
      confidence: num(a.confidence, { min: 0, max: 100, fallback: 0 }),
    }))
    .filter((a) => a.diseaseName);
}

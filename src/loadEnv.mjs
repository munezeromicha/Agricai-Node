/**
 * Loads `.env` before anything else in the process.
 *
 * This module exists because of a real outage. In ESM every `import` is evaluated
 * before the importing module's own body runs, so a `dotenv.config()` call sitting
 * below the imports in `server.mjs` executes *after* `platformApi.mjs` → `jwt.mjs`
 * have already read `process.env`. Those modules therefore saw an empty environment
 * and silently fell back to their defaults — including the development signing key.
 *
 * Importing this file as the **first** import of the entry point fixes the ordering
 * for every module underneath it. Keep it first; it is not a stylistic import.
 *
 * `ENV_FILE` overrides the path (used by tests and by multi-environment deploys).
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = process.env.ENV_FILE?.trim() || path.join(ROOT, ".env");

dotenv.config({ path: envPath });

export { envPath };

/**
 * Environment doctor — run before a deploy, or on the server when the API is down.
 *
 *   npm run doctor
 *
 * Checks everything that can stop this API from serving traffic, in the order a
 * request meets it: environment → port → data store → the process itself → the public
 * hostname. Exits non-zero if any blocking problem is found, so a deploy script can
 * refuse to restart into a crash loop.
 */
import dotenv from "dotenv";
import { existsSync, accessSync, constants, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const PUBLIC_HOST = process.env.DOCTOR_PUBLIC_URL?.trim() || "https://api.agric-ai.com";
const PORT = Number(process.env.PORT) || 3008;

const problems = [];
const warnings = [];

function ok(label, detail = "") {
  console.log(`  OK    ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label, detail, fix) {
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  problems.push({ label, detail, fix });
}
function warn(label, detail, fix) {
  console.log(`  WARN  ${label}${detail ? ` — ${detail}` : ""}`);
  warnings.push({ label, detail, fix });
}

console.log("\nAGRIC AI platform API — environment check\n");

// --- 1. Environment ---
console.log("Environment");

if (!existsSync(path.join(ROOT, ".env"))) {
  bad(".env file", "not found", "cp .env.example .env, then fill in the values");
} else {
  ok(".env file", "present");
}

const isProd = process.env.NODE_ENV === "production";
ok("NODE_ENV", process.env.NODE_ENV || "(unset — treated as development)");

const { jwtSecretProblem } = await import("../src/lib/jwt.mjs").catch(() => ({ jwtSecretProblem: null }));
const secret = process.env.JWT_SECRET?.trim() ?? "";
const secretIssue = jwtSecretProblem ? jwtSecretProblem(secret, "production") : null;
if (secretIssue) {
  const fix =
    'node -e "console.log(require(\'node:crypto\').randomBytes(48).toString(\'hex\'))" → put it in .env as JWT_SECRET, then: pm2 restart Agricai-Node';
  if (isProd) bad("JWT_SECRET", secretIssue, fix);
  // Not production yet, but this exact value will refuse to boot once NODE_ENV=production.
  else warn("JWT_SECRET", `${secretIssue} — this WILL block startup in production`, fix);
} else {
  ok("JWT_SECRET", `${secret.length} characters`);
}

const origins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (origins.length === 0) {
  warn("CORS_ORIGINS", "unset — only the built-in production origins are allowed", "CORS_ORIGINS=https://agric-ai.com,https://www.agric-ai.com");
} else {
  ok("CORS_ORIGINS", `${origins.length} origin(s)`);
}

if (!process.env.SUPERADMIN_EMAIL || !process.env.SUPERADMIN_PASSWORD) {
  warn("SuperAdmin seed", "SUPERADMIN_EMAIL/PASSWORD unset — no admin account will be created", "set both in .env");
} else if (isProd && process.env.SUPERADMIN_PASSWORD.length < 12) {
  bad("SUPERADMIN_PASSWORD", "shorter than 12 characters — the seed is skipped in production", "use a longer password");
} else {
  ok("SuperAdmin seed", process.env.SUPERADMIN_EMAIL);
}

if (!process.env.GEMINI_API_KEY?.trim()) {
  warn("GEMINI_API_KEY", "unset — /api/chat returns 503, everything else works", "set it to enable the AI assistant");
} else {
  ok("GEMINI_API_KEY", "configured");
}

// --- 2. Data store ---
console.log("\nData store");
const dbPath = path.resolve(ROOT, process.env.DATABASE_PATH?.trim() || "./data/store.json");
const dbDir = path.dirname(dbPath);
try {
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  accessSync(dbDir, constants.W_OK);
  ok("store directory writable", dbDir);
} catch (err) {
  bad("store directory", `not writable (${err.code})`, `chown/chmod ${dbDir} so the API user can write it`);
}
if (existsSync(dbPath)) {
  try {
    const { readFileSync, statSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(dbPath, "utf8"));
    const size = (statSync(dbPath).size / 1024).toFixed(1);
    ok("store.json", `${parsed.users?.length ?? 0} users, ${parsed.scans?.length ?? 0} scans, ${size} kB`);
  } catch (err) {
    bad("store.json", `unreadable or corrupt (${err.message})`, "restore the newest file from backups/");
  }
} else {
  warn("store.json", "does not exist yet — it is created empty on first start", "");
}

// --- 3. Port ---
console.log("\nPort");
const portState = await new Promise((resolve) => {
  const socket = net.connect({ port: PORT, host: "127.0.0.1" });
  socket.setTimeout(1500);
  socket.on("connect", () => {
    socket.destroy();
    resolve("in-use");
  });
  socket.on("timeout", () => {
    socket.destroy();
    resolve("free");
  });
  socket.on("error", () => resolve("free"));
});

if (portState === "in-use") {
  // Something answers locally: either this API (good) or a stale process (bad).
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) ok(`localhost:${PORT}`, `API healthy (${body.service ?? "api"})`);
    else bad(`localhost:${PORT}`, `something is listening but /health returned ${res.status}`, "pm2 logs Agricai-Node --lines 50");
  } catch {
    bad(`localhost:${PORT}`, "port occupied by a process that does not answer /health", `stop it, or set a different PORT in .env`);
  }
} else {
  bad(
    `localhost:${PORT}`,
    "nothing is listening — this is what makes Caddy return 502",
    "pm2 start ecosystem.config.cjs   (then: pm2 logs Agricai-Node --lines 50)",
  );
}

// --- 4. Public hostname ---
console.log("\nPublic endpoint");
try {
  const res = await fetch(`${PUBLIC_HOST}/health`, { signal: AbortSignal.timeout(8000) });
  if (res.ok) {
    ok(`${PUBLIC_HOST}/health`, `HTTP ${res.status}`);
  } else if (res.status === 502 || res.status === 503) {
    bad(
      `${PUBLIC_HOST}/health`,
      `HTTP ${res.status} — the proxy cannot reach the API`,
      "the API process is down; a 502 has no CORS headers, which is why the browser reports a CORS error",
    );
  } else {
    warn(`${PUBLIC_HOST}/health`, `HTTP ${res.status}`, "");
  }
} catch (err) {
  warn(`${PUBLIC_HOST}/health`, `unreachable from here (${err.name})`, "fine if this machine has no internet or DNS for it");
}

// --- Summary ---
console.log("");
if (problems.length === 0 && warnings.length === 0) {
  console.log("All checks passed.\n");
  process.exit(0);
}

if (warnings.length > 0) {
  console.log(`${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  - ${w.label}: ${w.detail}${w.fix ? `\n      fix: ${w.fix}` : ""}`);
  console.log("");
}

if (problems.length > 0) {
  console.log(`${problems.length} blocking problem(s):`);
  for (const p of problems) console.log(`  - ${p.label}: ${p.detail}${p.fix ? `\n      fix: ${p.fix}` : ""}`);
  console.log("");
  process.exit(1);
}

process.exit(0);

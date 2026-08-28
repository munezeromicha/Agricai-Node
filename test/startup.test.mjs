/**
 * Regression tests for the production outage of 2026-08-23.
 *
 * The API refused to start with "JWT_SECRET is not set" even though `.env` contained a
 * 96-character secret: ESM evaluates imports before the entry point's `dotenv.config()`,
 * so `jwt.mjs` read an empty environment. These tests boot the real `src/server.mjs`
 * with the secret **only** in an env file — the exact condition that failed.
 */
import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { jwtSecretProblem } from "../src/lib/jwt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRONG_SECRET = "f".repeat(64);
const children = [];
const tmpDirs = [];

after(() => {
  for (const child of children) child.kill();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Boots the real server with `.env` content written to a temp file, and no secrets in
 * the inherited process environment.
 */
async function bootServer(envFileContents, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agricai-startup-"));
  tmpDirs.push(dir);
  const envFile = path.join(dir, "test.env");
  const port = await freePort();

  writeFileSync(
    envFile,
    [`PORT=${port}`, `DATABASE_PATH=${path.join(dir, "store.json").replace(/\\/g, "/")}`, ...envFileContents].join("\n"),
    "utf8",
  );

  const env = { ...process.env, ENV_FILE: envFile, ...extraEnv };
  // The whole point is that these must come from the file, not the environment.
  delete env.JWT_SECRET;
  delete env.PORT;
  delete env.DATABASE_PATH;
  delete env.SUPERADMIN_EMAIL;
  delete env.SUPERADMIN_PASSWORD;

  const child = spawn(process.execPath, ["src/server.mjs"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);

  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  child.stdout.on("data", (d) => (stdout += String(d)));

  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const healthy = (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch {
        /* not up yet */
      }
      if (child.exitCode !== null) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })();

  const result = await Promise.race([healthy, exited.then(() => false)]);
  return { ok: result, port, child, exitCode: child.exitCode, get stderr() { return stderr; }, get stdout() { return stdout; } };
}

describe("server startup", () => {
  it("boots in production with the secret supplied only through the env file", async () => {
    const boot = await bootServer([
      `JWT_SECRET=${STRONG_SECRET}`,
      "SUPERADMIN_EMAIL=admin@startup.test",
      "SUPERADMIN_PASSWORD=startup-admin-password",
      "BCRYPT_ROUNDS=4",
    ], { NODE_ENV: "production" });

    assert.equal(boot.ok, true, `server did not become healthy. stderr:\n${boot.stderr}`);

    const res = await fetch(`http://127.0.0.1:${boot.port}/health`);
    const body = await res.json();
    assert.equal(body.ok, true);
    boot.child.kill();
  });

  it("actually uses the env-file secret to sign tokens, not the dev fallback", async () => {
    const boot = await bootServer([
      `JWT_SECRET=${STRONG_SECRET}`,
      "SUPERADMIN_EMAIL=admin@startup.test",
      "SUPERADMIN_PASSWORD=startup-admin-password",
      "BCRYPT_ROUNDS=4",
    ], { NODE_ENV: "production" });
    assert.equal(boot.ok, true, `server did not become healthy. stderr:\n${boot.stderr}`);

    const res = await fetch(`http://127.0.0.1:${boot.port}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Startup", email: "startup@farm.rw", password: "startup-pass-123" }),
    });
    const body = await res.json();
    assert.equal(res.status, 201);

    const jwt = (await import("jsonwebtoken")).default;
    // Verifies with the env-file secret …
    const decoded = jwt.verify(body.accessToken, STRONG_SECRET);
    assert.equal(decoded.email, "startup@farm.rw");
    // … and must NOT verify with the public development key.
    assert.throws(() => jwt.verify(body.accessToken, "agricai-dev-secret-change-in-production"));
    boot.child.kill();
  });

  it("refuses to start in production when the env file has no secret", async () => {
    const boot = await bootServer(["SUPERADMIN_EMAIL=admin@startup.test"], { NODE_ENV: "production" });
    assert.equal(boot.ok, false);
    assert.equal(boot.child.exitCode, 1, "expected a clean exit(1), not a crash or a hang");
    assert.match(boot.stderr, /insecure JWT_SECRET/);
    assert.match(boot.stderr, /JWT_SECRET is not set/);
  });

  it("refuses to start in production with a short secret", async () => {
    const boot = await bootServer(["JWT_SECRET=tooshort"], { NODE_ENV: "production" });
    assert.equal(boot.ok, false);
    assert.match(boot.stderr, /only 8 characters/);
  });

  it("still starts in development without a secret", async () => {
    const boot = await bootServer(["SUPERADMIN_EMAIL=admin@startup.test", "SUPERADMIN_PASSWORD=dev-password", "BCRYPT_ROUNDS=4"], {
      NODE_ENV: "development",
    });
    assert.equal(boot.ok, true, `server did not become healthy. stderr:\n${boot.stderr}`);
    boot.child.kill();
  });
});

describe("jwtSecretProblem", () => {
  it("accepts a strong secret in production", () => {
    assert.equal(jwtSecretProblem(STRONG_SECRET, "production"), null);
  });

  it("rejects missing, placeholder and short secrets", () => {
    assert.match(jwtSecretProblem("", "production"), /not set/);
    assert.match(jwtSecretProblem("change-me-in-production", "production"), /placeholder/);
    assert.match(jwtSecretProblem("agricai-dev-secret-change-in-production", "production"), /placeholder/);
    assert.match(jwtSecretProblem("short", "production"), /only 5 characters/);
  });

  it("does not block development", () => {
    assert.equal(jwtSecretProblem("", "development"), null);
    assert.equal(jwtSecretProblem("short", undefined), null);
  });
});

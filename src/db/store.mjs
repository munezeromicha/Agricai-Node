import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, "..", "..", "data", "store.json");

const EMPTY_STORE = {
  users: [],
  refreshTokens: [],
  scans: [],
  subscriptions: [],
};

let dbPath = DEFAULT_DB_PATH;

export function initStore(customPath) {
  if (customPath) dbPath = path.resolve(customPath);
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(dbPath)) {
    writeFileSync(dbPath, JSON.stringify(EMPTY_STORE, null, 2), "utf8");
  }
}

function readStore() {
  initStore();
  try {
    return JSON.parse(readFileSync(dbPath, "utf8"));
  } catch {
    return structuredClone(EMPTY_STORE);
  }
}

function writeStore(data) {
  writeFileSync(dbPath, JSON.stringify(data, null, 2), "utf8");
}

export function listUsers() {
  return readStore().users;
}

export function findUserByEmail(email) {
  const normalized = email.trim().toLowerCase();
  return readStore().users.find((u) => u.email === normalized) ?? null;
}

export function findUserById(id) {
  return readStore().users.find((u) => u.id === id) ?? null;
}

export function createUser(user) {
  const store = readStore();
  store.users.push(user);
  writeStore(store);
  return user;
}

export function updateUser(id, patch) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  store.users[idx] = { ...store.users[idx], ...patch, id };
  writeStore(store);
  return store.users[idx];
}

export function saveRefreshToken(record) {
  const store = readStore();
  store.refreshTokens.push(record);
  writeStore(store);
  return record;
}

export function findRefreshToken(tokenHash) {
  return readStore().refreshTokens.find((t) => t.tokenHash === tokenHash) ?? null;
}

export function deleteRefreshToken(tokenHash) {
  const store = readStore();
  store.refreshTokens = store.refreshTokens.filter((t) => t.tokenHash !== tokenHash);
  writeStore(store);
}

export function purgeExpiredRefreshTokens() {
  const store = readStore();
  const now = Date.now();
  store.refreshTokens = store.refreshTokens.filter((t) => t.expiresAt > now);
  writeStore(store);
}

export function addScan(scan) {
  const store = readStore();
  store.scans.unshift(scan);
  if (store.scans.length > 5000) store.scans.length = 5000;
  writeStore(store);
  return scan;
}

export function listScansForUser(userId, limit = 50) {
  return readStore().scans.filter((s) => s.userId === userId).slice(0, limit);
}

export function countScansToday(userId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const ts = start.getTime();
  return readStore().scans.filter((s) => s.userId === userId && s.createdAt >= ts).length;
}

export function getSubscription(userId) {
  return readStore().subscriptions.find((s) => s.userId === userId) ?? null;
}

export function upsertSubscription(record) {
  const store = readStore();
  const idx = store.subscriptions.findIndex((s) => s.userId === record.userId);
  if (idx === -1) store.subscriptions.push(record);
  else store.subscriptions[idx] = { ...store.subscriptions[idx], ...record };
  writeStore(store);
  return record;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
    language: user.language ?? "en",
    createdAt: user.createdAt,
  };
}

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, "..", "..", "data", "store.json");

/**
 * Collections mirror the PostgreSQL tables documented in `src/db/schema.sql`.
 * The JSON file is the default driver (no infra needed for pilot deployments);
 * `schema.sql` is the migration target once a managed Postgres is provisioned.
 */
const EMPTY_STORE = {
  users: [],
  refreshTokens: [],
  farms: [],
  scans: [],
  feedback: [],
  recommendations: [],
  notifications: [],
  weatherObservations: [],
  chatMessages: [],
  subscriptions: [],
  payments: [],
};

let dbPath = DEFAULT_DB_PATH;
/** In-process cache so read-heavy endpoints (analytics) do not re-parse the file per call. */
let cache = null;
/** mtime of the file the cache was built from — a foreign write invalidates it. */
let cacheMtimeMs = 0;

export function initStore(customPath) {
  if (customPath && path.resolve(customPath) !== dbPath) {
    dbPath = path.resolve(customPath);
    cache = null;
  }
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(dbPath)) {
    writeFileSync(dbPath, JSON.stringify(EMPTY_STORE, null, 2), "utf8");
    cache = structuredClone(EMPTY_STORE);
    cacheMtimeMs = fileMtimeMs();
  }
}

function fileMtimeMs() {
  try {
    return statSync(dbPath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Adds collections introduced after a store file was first written. */
function withDefaults(data) {
  const out = { ...structuredClone(EMPTY_STORE), ...data };
  for (const key of Object.keys(EMPTY_STORE)) {
    if (!Array.isArray(out[key])) out[key] = [];
  }
  return out;
}

function readStore() {
  if (cache && fileMtimeMs() === cacheMtimeMs) return cache;
  initStore();
  try {
    cache = withDefaults(JSON.parse(readFileSync(dbPath, "utf8")));
  } catch {
    cache = structuredClone(EMPTY_STORE);
  }
  cacheMtimeMs = fileMtimeMs();
  return cache;
}

/** Write through a temp file so a crash mid-write cannot truncate the store. */
function writeStore(data) {
  cache = data;
  const tmp = `${dbPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, dbPath);
  cacheMtimeMs = fileMtimeMs();
}

/** Test helper — drops the in-process cache so a fresh file is re-read. */
export function resetStoreCache() {
  cache = null;
  cacheMtimeMs = 0;
}

function startOfTodayMs() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// --- Users ---

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

export function deleteUser(id) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === id);
  if (idx === -1) return false;
  store.users.splice(idx, 1);
  store.scans = store.scans.filter((s) => s.userId !== id);
  store.chatMessages = store.chatMessages.filter((m) => m.userId !== id);
  store.refreshTokens = store.refreshTokens.filter((t) => t.userId !== id);
  store.subscriptions = store.subscriptions.filter((s) => s.userId !== id);
  store.farms = store.farms.filter((f) => f.userId !== id);
  store.feedback = store.feedback.filter((f) => f.userId !== id);
  store.recommendations = store.recommendations.filter((r) => r.userId !== id);
  store.notifications = store.notifications.filter((n) => n.userId !== id);
  writeStore(store);
  return true;
}

// --- Refresh tokens ---

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
  const before = store.refreshTokens.length;
  store.refreshTokens = store.refreshTokens.filter((t) => t.expiresAt > now);
  if (store.refreshTokens.length !== before) writeStore(store);
}

// --- Scans (crop_scans + predictions) ---

export function addScan(scan) {
  const store = readStore();
  store.scans.unshift(scan);
  if (store.scans.length > 20000) store.scans.length = 20000;
  writeStore(store);
  return scan;
}

/** Offline sync sends a client-generated id; return the stored scan when already synced. */
export function findScanByClientId(userId, clientId) {
  if (!clientId) return null;
  return readStore().scans.find((s) => s.userId === userId && s.clientId === clientId) ?? null;
}

export function findScanById(id) {
  return readStore().scans.find((s) => s.id === id) ?? null;
}

export function listScansForUser(userId, limit = 50) {
  return readStore()
    .scans.filter((s) => s.userId === userId)
    .slice(0, limit);
}

export function countScansToday(userId) {
  const ts = startOfTodayMs();
  return readStore().scans.filter((s) => s.userId === userId && s.createdAt >= ts).length;
}

export function listAllScans(limit = 200) {
  return readStore().scans.slice(0, limit);
}

// --- Farms ---

export function listFarmsForUser(userId) {
  return readStore().farms.filter((f) => f.userId === userId);
}

export function upsertFarm(farm) {
  const store = readStore();
  const idx = store.farms.findIndex((f) => f.id === farm.id);
  if (idx === -1) store.farms.push(farm);
  else store.farms[idx] = { ...store.farms[idx], ...farm };
  writeStore(store);
  return farm;
}

/** Most recent GPS fix a farmer supplied — farm record first, else last located scan. */
export function lastKnownLocation(userId) {
  const store = readStore();
  const farm = store.farms.find((f) => f.userId === userId && f.latitude != null && f.longitude != null);
  if (farm) {
    return { latitude: farm.latitude, longitude: farm.longitude, source: "farm", label: farm.name ?? null };
  }
  const scan = store.scans.find((s) => s.userId === userId && s.latitude != null && s.longitude != null);
  if (scan) {
    return { latitude: scan.latitude, longitude: scan.longitude, source: "scan", label: scan.locationLabel ?? null };
  }
  return null;
}

// --- Feedback ---

export function addFeedback(record) {
  const store = readStore();
  store.feedback.unshift(record);
  if (store.feedback.length > 20000) store.feedback.length = 20000;
  writeStore(store);
  return record;
}

export function findFeedbackForScan(scanId) {
  return readStore().feedback.find((f) => f.scanId === scanId) ?? null;
}

export function updateFeedback(id, patch) {
  const store = readStore();
  const idx = store.feedback.findIndex((f) => f.id === id);
  if (idx === -1) return null;
  store.feedback[idx] = { ...store.feedback[idx], ...patch, id };
  writeStore(store);
  return store.feedback[idx];
}

export function listFeedbackForUser(userId, limit = 100) {
  return readStore()
    .feedback.filter((f) => f.userId === userId)
    .slice(0, limit);
}

export function listAllFeedback(limit = 200) {
  return readStore().feedback.slice(0, limit);
}

// --- Recommendations ---

export function addRecommendations(records) {
  if (records.length === 0) return [];
  const store = readStore();
  store.recommendations.unshift(...records);
  if (store.recommendations.length > 20000) store.recommendations.length = 20000;
  writeStore(store);
  return records;
}

export function listRecommendationsForUser(userId, limit = 50) {
  return readStore()
    .recommendations.filter((r) => r.userId === userId)
    .slice(0, limit);
}

export function markRecommendationDone(userId, id, done) {
  const store = readStore();
  const idx = store.recommendations.findIndex((r) => r.id === id && r.userId === userId);
  if (idx === -1) return null;
  store.recommendations[idx] = {
    ...store.recommendations[idx],
    status: done ? "done" : "pending",
    completedAt: done ? Date.now() : null,
  };
  writeStore(store);
  return store.recommendations[idx];
}

// --- Notifications ---

export function addNotification(record) {
  const store = readStore();
  store.notifications.unshift(record);
  if (store.notifications.length > 20000) store.notifications.length = 20000;
  writeStore(store);
  return record;
}

export function listNotifications(userId, limit = 50) {
  return readStore()
    .notifications.filter((n) => n.userId === userId)
    .slice(0, limit);
}

export function markNotificationRead(userId, id) {
  const store = readStore();
  const idx = store.notifications.findIndex((n) => n.id === id && n.userId === userId);
  if (idx === -1) return null;
  store.notifications[idx] = { ...store.notifications[idx], readAt: Date.now() };
  writeStore(store);
  return store.notifications[idx];
}

// --- Weather observations (history for risk trends) ---

export function addWeatherObservation(record) {
  const store = readStore();
  store.weatherObservations.unshift(record);
  if (store.weatherObservations.length > 5000) store.weatherObservations.length = 5000;
  writeStore(store);
  return record;
}

export function listWeatherObservations(limit = 200) {
  return readStore().weatherObservations.slice(0, limit);
}

// --- Chat ---

export function addChatMessage(record) {
  const store = readStore();
  store.chatMessages.unshift(record);
  if (store.chatMessages.length > 10000) store.chatMessages.length = 10000;
  writeStore(store);
  return record;
}

export function countChatsToday(userId) {
  const ts = startOfTodayMs();
  return readStore().chatMessages.filter((m) => m.userId === userId && m.createdAt >= ts).length;
}

export function listChatsForUser(userId, limit = 50) {
  return readStore()
    .chatMessages.filter((m) => m.userId === userId)
    .slice(0, limit);
}

// --- Billing ---

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

export function addPayment(record) {
  const store = readStore();
  store.payments.unshift(record);
  if (store.payments.length > 20000) store.payments.length = 20000;
  writeStore(store);
  return record;
}

export function listPayments(limit = 200) {
  return readStore().payments.slice(0, limit);
}

// --- Aggregates ---

export function getPlatformStats() {
  const store = readStore();
  const ts = startOfTodayMs();
  const users = store.users;
  const scans = store.scans;
  const chats = store.chatMessages;
  return {
    totalUsers: users.length,
    farmers: users.filter((u) => u.role !== "superadmin").length,
    superAdmins: users.filter((u) => u.role === "superadmin").length,
    totalScans: scans.length,
    scansToday: scans.filter((s) => s.createdAt >= ts).length,
    totalChats: chats.length,
    chatsToday: chats.filter((m) => m.createdAt >= ts).length,
    totalFeedback: store.feedback.length,
    feedbackToday: store.feedback.filter((f) => f.createdAt >= ts).length,
  };
}

/** Raw slices used by the analytics module; keeps aggregation logic out of the store. */
export function analyticsSnapshot() {
  const store = readStore();
  return {
    users: store.users,
    scans: store.scans,
    feedback: store.feedback,
    chatMessages: store.chatMessages,
    subscriptions: store.subscriptions,
    payments: store.payments,
    farms: store.farms,
  };
}

export { dayKey, startOfTodayMs };

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role === "superadmin" ? "superadmin" : "farmer",
    plan: user.plan,
    language: user.language ?? "en",
    phone: user.phone ?? null,
    district: user.district ?? null,
    createdAt: user.createdAt,
  };
}

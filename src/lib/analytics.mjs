/**
 * Executive analytics — the numbers a CEO/board actually asks for:
 * growth, engagement, model quality (from farmer feedback), disease surveillance,
 * geography and revenue. Pure functions over a store snapshot so they can be tested.
 */

import { confidenceLevel } from "./confidence.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function emptySeries(days, now) {
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    series.push({ date: dayKey(now - i * DAY_MS), value: 0 });
  }
  return series;
}

function fillSeries(items, days, now, tsOf = (x) => x.createdAt) {
  const series = emptySeries(days, now);
  const index = new Map(series.map((p, i) => [p.date, i]));
  const from = now - (days - 1) * DAY_MS;
  for (const item of items) {
    const ts = tsOf(item);
    if (ts < startOfDay(from) || ts > now) continue;
    const i = index.get(dayKey(ts));
    if (i !== undefined) series[i].value += 1;
  }
  return series;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function topN(counts, n) {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, n);
}

function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * @param {object} snapshot from `analyticsSnapshot()`
 * @param {object} opts
 * @param {number} [opts.now] epoch ms (injectable for tests)
 * @param {number} [opts.days] length of the daily series
 */
export function buildAnalytics(snapshot, { now = Date.now(), days = 30 } = {}) {
  const users = snapshot.users ?? [];
  const scans = snapshot.scans ?? [];
  const feedback = snapshot.feedback ?? [];
  const chats = snapshot.chatMessages ?? [];
  const subscriptions = snapshot.subscriptions ?? [];
  const payments = snapshot.payments ?? [];

  const farmers = users.filter((u) => u.role !== "superadmin");
  const last7 = now - 7 * DAY_MS;
  const prev7 = now - 14 * DAY_MS;
  const last30 = now - 30 * DAY_MS;

  const scans7 = scans.filter((s) => s.createdAt >= last7);
  const scansPrev7 = scans.filter((s) => s.createdAt >= prev7 && s.createdAt < last7);
  const scans30 = scans.filter((s) => s.createdAt >= last30);

  // --- Growth ---
  const newUsers7 = farmers.filter((u) => u.createdAt >= last7).length;
  const newUsersPrev7 = farmers.filter((u) => u.createdAt >= prev7 && u.createdAt < last7).length;

  // --- Engagement ---
  const activeIds7 = new Set(scans7.map((s) => s.userId));
  const activeIds30 = new Set(scans30.map((s) => s.userId));
  for (const c of chats) {
    if (c.createdAt >= last7) activeIds7.add(c.userId);
    if (c.createdAt >= last30) activeIds30.add(c.userId);
  }
  const returningFarmers = countReturning(scans, now);

  // --- Model quality (feedback-derived) ---
  const correct = feedback.filter((f) => f.verdict === "correct").length;
  const incorrect = feedback.filter((f) => f.verdict === "incorrect").length;
  const unsure = feedback.filter((f) => f.verdict === "unsure").length;
  const rated = feedback.filter((f) => Number.isFinite(f.rating));
  const avgRating = rated.length
    ? Math.round((rated.reduce((s, f) => s + f.rating, 0) / rated.length) * 10) / 10
    : null;

  // --- Confidence distribution ---
  const bands = { high: 0, medium: 0, low: 0, very_low: 0 };
  let confSum = 0;
  for (const s of scans) {
    const level = s.confidenceLevel || confidenceLevel(s.confidence, s.marginPct ?? null);
    if (bands[level] !== undefined) bands[level] += 1;
    confSum += Number(s.confidence) || 0;
  }

  // --- Distributions ---
  const cropCounts = new Map();
  const diseaseCounts = new Map();
  const districtCounts = new Map();
  const diseases7 = new Map();
  const diseasesPrev7 = new Map();
  let locatedScans = 0;
  let offlineScans = 0;

  for (const s of scans) {
    const crop = s.crop || "unspecified";
    cropCounts.set(crop, (cropCounts.get(crop) ?? 0) + 1);
    if (s.type === "disease" || s.type === "pest") {
      const d = s.diseaseName || "Unknown";
      diseaseCounts.set(d, (diseaseCounts.get(d) ?? 0) + 1);
      if (s.createdAt >= last7) diseases7.set(d, (diseases7.get(d) ?? 0) + 1);
      else if (s.createdAt >= prev7) diseasesPrev7.set(d, (diseasesPrev7.get(d) ?? 0) + 1);
    }
    if (s.latitude != null && s.longitude != null) locatedScans += 1;
    if (s.syncedOffline) offlineScans += 1;
    const district = s.district || s.locationLabel || null;
    if (district) districtCounts.set(district, (districtCounts.get(district) ?? 0) + 1);
  }

  // --- Surveillance: what is spiking this week ---
  const outbreakAlerts = [];
  for (const [disease, count] of diseases7) {
    const before = diseasesPrev7.get(disease) ?? 0;
    const growth = before === 0 ? (count >= 3 ? 100 : 0) : Math.round(((count - before) / before) * 100);
    if (count >= 3 && growth >= 50) {
      outbreakAlerts.push({ disease, count, previousCount: before, growthPct: growth });
    }
  }
  outbreakAlerts.sort((a, b) => b.growthPct - a.growthPct || b.count - a.count);

  // --- Revenue ---
  const paidSubs = subscriptions.filter((s) => s.status === "active" && s.plan !== "free");
  const paidPayments = payments.filter((p) => p.status === "paid");
  const revenueCents = paidPayments.reduce((sum, p) => sum + (p.amountCents ?? 0), 0);

  return {
    generatedAt: now,
    totals: {
      farmers: farmers.length,
      superAdmins: users.length - farmers.length,
      scans: scans.length,
      chats: chats.length,
      feedback: feedback.length,
      farms: (snapshot.farms ?? []).length,
    },
    growth: {
      newFarmers7d: newUsers7,
      newFarmersPrev7d: newUsersPrev7,
      newFarmersChangePct: changePct(newUsers7, newUsersPrev7),
      scans7d: scans7.length,
      scansPrev7d: scansPrev7.length,
      scansChangePct: changePct(scans7.length, scansPrev7.length),
      signupsSeries: fillSeries(farmers, days, now),
      scansSeries: fillSeries(scans, days, now),
    },
    engagement: {
      activeFarmers7d: activeIds7.size,
      activeFarmers30d: activeIds30.size,
      activationRatePct: pct(activeIds30.size, farmers.length),
      returningFarmers: returningFarmers,
      scansPerActiveFarmer30d: activeIds30.size
        ? Math.round((scans30.length / activeIds30.size) * 10) / 10
        : 0,
      chats7d: chats.filter((c) => c.createdAt >= last7).length,
    },
    modelQuality: {
      feedbackCount: feedback.length,
      correct,
      incorrect,
      unsure,
      accuracyPct: correct + incorrect > 0 ? pct(correct, correct + incorrect) : null,
      feedbackCoveragePct: pct(feedback.length, scans.length),
      averageRating: avgRating,
      avgConfidencePct: scans.length ? Math.round((confSum / scans.length) * 10) / 10 : 0,
      confidenceBands: bands,
      lowConfidenceSharePct: pct(bands.low + bands.very_low, scans.length),
    },
    distribution: {
      byCrop: topN(cropCounts, 12),
      byDisease: topN(diseaseCounts, 10),
      byDistrict: topN(districtCounts, 10),
      locatedScanSharePct: pct(locatedScans, scans.length),
      offlineScanSharePct: pct(offlineScans, scans.length),
    },
    surveillance: {
      alerts: outbreakAlerts.slice(0, 5),
      diseaseCases7d: [...diseases7.values()].reduce((a, b) => a + b, 0),
    },
    revenue: {
      paidSubscriptions: paidSubs.length,
      conversionRatePct: pct(paidSubs.length, farmers.length),
      payingRevenueUsd: Math.round(revenueCents) / 100,
      payments: paidPayments.length,
    },
  };
}

function changePct(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

/** Farmers with scans on 2+ distinct days — the honest retention proxy for a young product. */
function countReturning(scans, now) {
  const byUser = new Map();
  const from = now - 30 * DAY_MS;
  for (const s of scans) {
    if (s.createdAt < from) continue;
    if (!byUser.has(s.userId)) byUser.set(s.userId, new Set());
    byUser.get(s.userId).add(dayKey(s.createdAt));
  }
  let n = 0;
  for (const days of byUser.values()) if (days.size >= 2) n += 1;
  return n;
}

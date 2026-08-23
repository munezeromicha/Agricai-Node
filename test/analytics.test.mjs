import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildAnalytics } from "../src/lib/analytics.mjs";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function snapshot() {
  return {
    users: [
      { id: "admin", role: "superadmin", createdAt: NOW - 200 * DAY },
      { id: "f1", role: "farmer", createdAt: NOW - 3 * DAY },
      { id: "f2", role: "farmer", createdAt: NOW - 10 * DAY },
      { id: "f3", role: "farmer", createdAt: NOW - 60 * DAY },
    ],
    scans: [
      { id: "s1", userId: "f1", crop: "tomato", diseaseName: "Late Blight", type: "disease", confidence: 91, confidenceLevel: "high", createdAt: NOW - 1 * DAY, latitude: -1.9, longitude: 30.1, district: "Musanze" },
      { id: "s2", userId: "f1", crop: "tomato", diseaseName: "Late Blight", type: "disease", confidence: 88, confidenceLevel: "high", createdAt: NOW - 2 * DAY, latitude: -1.9, longitude: 30.1, district: "Musanze" },
      { id: "s3", userId: "f2", crop: "maize", diseaseName: "Healthy", type: "healthy", confidence: 95, confidenceLevel: "high", createdAt: NOW - 3 * DAY, district: "Huye" },
      { id: "s4", userId: "f2", crop: "maize", diseaseName: "Fall Armyworm", type: "pest", confidence: 55, confidenceLevel: "low", createdAt: NOW - 6 * DAY, syncedOffline: true },
      { id: "s5", userId: "f3", crop: "tomato", diseaseName: "Late Blight", type: "disease", confidence: 80, confidenceLevel: "medium", createdAt: NOW - 12 * DAY },
      { id: "s6", userId: "f3", crop: "tomato", diseaseName: "Late Blight", type: "disease", confidence: 86, confidenceLevel: "high", createdAt: NOW - 4 * DAY, district: "Musanze" },
    ],
    feedback: [
      { id: "fb1", userId: "f1", scanId: "s1", verdict: "correct", rating: 5, createdAt: NOW - DAY },
      { id: "fb2", userId: "f2", scanId: "s4", verdict: "incorrect", rating: 2, createdAt: NOW - 5 * DAY },
      { id: "fb3", userId: "f2", scanId: "s3", verdict: "correct", rating: 4, createdAt: NOW - 3 * DAY },
    ],
    chatMessages: [{ id: "c1", userId: "f1", createdAt: NOW - DAY }],
    subscriptions: [{ userId: "f1", plan: "pro", status: "active" }],
    payments: [{ id: "p1", userId: "f1", plan: "pro", amountCents: 499, status: "paid", createdAt: NOW - DAY }],
    farms: [{ id: "farm1", userId: "f1" }],
  };
}

describe("buildAnalytics", () => {
  const a = buildAnalytics(snapshot(), { now: NOW, days: 30 });

  it("counts farmers separately from admins", () => {
    assert.equal(a.totals.farmers, 3);
    assert.equal(a.totals.superAdmins, 1);
    assert.equal(a.totals.scans, 6);
  });

  it("reports week-over-week growth", () => {
    assert.equal(a.growth.scans7d, 5);
    assert.equal(a.growth.scansPrev7d, 1);
    assert.equal(a.growth.scansChangePct, 400);
    assert.equal(a.growth.newFarmers7d, 1);
  });

  it("builds a daily series covering the requested window", () => {
    assert.equal(a.growth.scansSeries.length, 30);
    assert.equal(a.growth.scansSeries.at(-1).date, "2026-03-10");
    const total = a.growth.scansSeries.reduce((s, p) => s + p.value, 0);
    assert.equal(total, 6);
  });

  it("measures engagement and retention", () => {
    assert.equal(a.engagement.activeFarmers7d, 3);
    assert.equal(a.engagement.activeFarmers30d, 3);
    assert.equal(a.engagement.returningFarmers, 3); // every farmer scanned on 2+ distinct days
  });

  it("derives model accuracy from farmer feedback", () => {
    assert.equal(a.modelQuality.correct, 2);
    assert.equal(a.modelQuality.incorrect, 1);
    assert.equal(a.modelQuality.accuracyPct, 66.7);
    assert.equal(a.modelQuality.feedbackCoveragePct, 50);
    assert.equal(a.modelQuality.averageRating, 3.7);
  });

  it("summarises confidence bands", () => {
    assert.equal(a.modelQuality.confidenceBands.high, 4);
    assert.equal(a.modelQuality.confidenceBands.medium, 1);
    assert.equal(a.modelQuality.confidenceBands.low, 1);
    assert.equal(a.modelQuality.lowConfidenceSharePct, 16.7);
  });

  it("ranks crops, diseases and districts", () => {
    assert.deepEqual(a.distribution.byCrop[0], { name: "tomato", count: 4 });
    assert.deepEqual(a.distribution.byDisease[0], { name: "Late Blight", count: 4 });
    assert.deepEqual(a.distribution.byDistrict[0], { name: "Musanze", count: 3 });
    assert.equal(a.distribution.locatedScanSharePct, 33.3);
    assert.equal(a.distribution.offlineScanSharePct, 16.7);
  });

  it("raises a surveillance alert for a spiking disease", () => {
    const alert = a.surveillance.alerts.find((x) => x.disease === "Late Blight");
    assert.ok(alert, "expected Late Blight outbreak alert");
    assert.equal(alert.count, 3);
    assert.equal(alert.previousCount, 1);
  });

  it("reports revenue and conversion", () => {
    assert.equal(a.revenue.paidSubscriptions, 1);
    assert.equal(a.revenue.payingRevenueUsd, 4.99);
    assert.equal(a.revenue.conversionRatePct, 33.3);
  });

  it("handles an empty platform without dividing by zero", () => {
    const empty = buildAnalytics(
      { users: [], scans: [], feedback: [], chatMessages: [], subscriptions: [], payments: [], farms: [] },
      { now: NOW },
    );
    assert.equal(empty.totals.farmers, 0);
    assert.equal(empty.modelQuality.accuracyPct, null);
    assert.equal(empty.engagement.activationRatePct, 0);
    assert.equal(empty.revenue.conversionRatePct, 0);
  });
});

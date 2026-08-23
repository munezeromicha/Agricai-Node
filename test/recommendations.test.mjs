import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildRecommendations } from "../src/lib/recommendations.mjs";

const NOW = Date.parse("2026-03-10T08:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function scan(overrides = {}) {
  return {
    id: "scan-1",
    diseaseName: "Late Blight",
    diseaseNameRw: "Kirabiranya",
    confidence: 92,
    confidenceLevel: "high",
    type: "disease",
    crop: "tomato",
    createdAt: NOW - DAY,
    ...overrides,
  };
}

const calmIntelligence = {
  riskLevel: "low",
  nextGoodSprayDate: "2026-03-12",
  advisories: [],
};

describe("buildRecommendations", () => {
  it("puts an urgent treatment first for a confident disease result", () => {
    const recs = buildRecommendations({ scans: [scan()], intelligence: calmIntelligence, now: NOW });
    assert.equal(recs[0].category, "treatment");
    assert.equal(recs[0].priority, "urgent");
    assert.match(recs[0].bodyEn, /Late Blight/);
    assert.match(recs[0].bodyEn, /2026-03-12/);
    assert.ok(recs[0].bodyRw.length > 20, "Kinyarwanda body must be populated");
  });

  it("asks for a re-scan instead of chemicals when confidence is low", () => {
    const recs = buildRecommendations({
      scans: [scan({ confidence: 48, confidenceLevel: "low" })],
      intelligence: calmIntelligence,
      now: NOW,
    });
    const first = recs.find((r) => r.category === "monitoring");
    assert.ok(first);
    assert.match(first.titleEn, /Re-scan/i);
    assert.equal(recs.some((r) => r.category === "treatment" && r.priority === "urgent"), false);
  });

  it("escalates a disease that keeps returning", () => {
    const recs = buildRecommendations({
      scans: [
        scan({ id: "a", createdAt: NOW - DAY }),
        scan({ id: "b", createdAt: NOW - 5 * DAY }),
        scan({ id: "c", createdAt: NOW - 9 * DAY }),
      ],
      intelligence: calmIntelligence,
      now: NOW,
    });
    const repeat = recs.find((r) => r.titleEn.includes("keeps coming back"));
    assert.ok(repeat, "expected a repeat-outbreak advisory");
    assert.equal(repeat.priority, "urgent");
    assert.match(repeat.bodyEn, /rotate/i);
  });

  it("does not flag a repeat when the two hits are outside the 14-day window", () => {
    const recs = buildRecommendations({
      scans: [scan({ id: "a", createdAt: NOW - DAY }), scan({ id: "b", createdAt: NOW - 40 * DAY })],
      intelligence: calmIntelligence,
      now: NOW,
    });
    assert.equal(recs.some((r) => r.titleEn.includes("keeps coming back")), false);
  });

  it("adds a protectant spray when fungal pressure is high on a susceptible crop", () => {
    const recs = buildRecommendations({
      scans: [scan({ type: "healthy", diseaseName: "Healthy", confidence: 95 })],
      intelligence: { riskLevel: "severe", nextGoodSprayDate: "2026-03-11", advisories: [] },
      crop: "tomato",
      now: NOW,
    });
    assert.ok(recs.some((r) => r.titleEn.includes("Protect your tomato")));
  });

  it("skips the protectant spray for crops not in the susceptible list", () => {
    const recs = buildRecommendations({
      scans: [],
      intelligence: { riskLevel: "severe", nextGoodSprayDate: null, advisories: [] },
      crop: "onion",
      now: NOW,
    });
    assert.equal(recs.some((r) => r.titleEn.startsWith("Protect your")), false);
  });

  it("onboards a farmer with no scans", () => {
    const recs = buildRecommendations({ scans: [], intelligence: null, now: NOW });
    assert.ok(recs.some((r) => r.titleEn === "Run your first scan"));
    assert.ok(recs.length >= 2);
  });

  it("passes weather advisories through with their priority", () => {
    const recs = buildRecommendations({
      scans: [],
      intelligence: {
        riskLevel: "moderate",
        nextGoodSprayDate: null,
        advisories: [
          {
            code: "irrigation",
            priority: "high",
            titleEn: "Dry spell — plan irrigation",
            titleRw: "Igihe cy'izuba",
            bodyEn: "Water early.",
            bodyRw: "Uhire mu gitondo.",
          },
        ],
      },
      now: NOW,
    });
    const irrigation = recs.find((r) => r.category === "irrigation");
    assert.ok(irrigation);
    assert.equal(irrigation.priority, "high");
  });

  it("returns results ordered by priority with no duplicates", () => {
    const recs = buildRecommendations({
      scans: [scan()],
      intelligence: {
        riskLevel: "high",
        nextGoodSprayDate: "2026-03-12",
        advisories: [
          { code: "fungal_pressure", priority: "high", titleEn: "A", titleRw: "A", bodyEn: "b", bodyRw: "b" },
          { code: "fungal_pressure", priority: "high", titleEn: "A", titleRw: "A", bodyEn: "b", bodyRw: "b" },
        ],
      },
      now: NOW,
    });
    const order = { urgent: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < recs.length; i++) {
      assert.ok(order[recs[i - 1].priority] <= order[recs[i].priority], "priorities must be non-decreasing");
    }
    const keys = recs.map((r) => `${r.category}|${r.titleEn}`);
    assert.equal(new Set(keys).size, keys.length, "no duplicate recommendations");
  });

  it("is deterministic for identical input", () => {
    const args = { scans: [scan()], intelligence: calmIntelligence, now: NOW };
    assert.deepEqual(buildRecommendations(args), buildRecommendations(args));
  });
});

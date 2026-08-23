import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { confidenceGuidance, confidenceLevel, isActionable } from "../src/lib/confidence.mjs";

describe("confidenceLevel", () => {
  it("bands a strong, well-separated prediction as high", () => {
    assert.equal(confidenceLevel(94, 40), "high");
    assert.equal(confidenceLevel(85, 12), "high");
  });

  it("demotes a high score that barely beats the runner-up", () => {
    assert.equal(confidenceLevel(92, 3), "medium");
  });

  it("bands mid-range predictions as medium", () => {
    assert.equal(confidenceLevel(70, 20), "medium");
    assert.equal(confidenceLevel(65, 6), "medium");
  });

  it("bands weak predictions as low and very_low", () => {
    assert.equal(confidenceLevel(55, 30), "low");
    assert.equal(confidenceLevel(44, 30), "very_low");
    assert.equal(confidenceLevel(0), "very_low");
  });

  it("works when no margin is reported", () => {
    assert.equal(confidenceLevel(90, null), "high");
    assert.equal(confidenceLevel(70, undefined), "medium");
  });

  it("clamps out-of-range and non-numeric input instead of throwing", () => {
    assert.equal(confidenceLevel(1000, null), "high");
    assert.equal(confidenceLevel(Number.NaN, null), "very_low");
    assert.equal(confidenceLevel("bogus", null), "very_low");
  });
});

describe("confidenceGuidance", () => {
  it("returns bilingual guidance for every band", () => {
    for (const level of ["high", "medium", "low", "very_low"]) {
      const g = confidenceGuidance(level);
      assert.ok(g.en.length > 20, `${level} EN guidance missing`);
      assert.ok(g.rw.length > 20, `${level} RW guidance missing`);
    }
  });

  it("tells low-confidence users not to act", () => {
    assert.match(confidenceGuidance("very_low").en, /do not act/i);
  });
});

describe("isActionable", () => {
  it("only allows treatment advice on high and medium bands", () => {
    assert.equal(isActionable("high"), true);
    assert.equal(isActionable("medium"), true);
    assert.equal(isActionable("low"), false);
    assert.equal(isActionable("very_low"), false);
  });
});

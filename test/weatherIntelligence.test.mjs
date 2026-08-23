import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildWeatherIntelligence,
  diseaseRiskIndex,
  riskLevelFromIndex,
  sprayWindow,
} from "../src/lib/weatherIntelligence.mjs";

function day(overrides = {}) {
  return {
    date: "2026-03-01",
    maxTemp: 24,
    minTemp: 15,
    weatherCode: 1,
    rainMm: 0,
    rainProbabilityPct: 5,
    windKph: 8,
    ...overrides,
  };
}

describe("diseaseRiskIndex", () => {
  it("scores warm, humid, wet weather as severe pressure", () => {
    const index = diseaseRiskIndex({ humidity: 95, temperature: 20, rainMm: 12, rainProbabilityPct: 90 });
    assert.ok(index >= 90, `expected >=90, got ${index}`);
    assert.equal(riskLevelFromIndex(index), "severe");
  });

  it("scores dry, hot weather as low pressure", () => {
    const index = diseaseRiskIndex({ humidity: 35, temperature: 34, rainMm: 0, rainProbabilityPct: 0 });
    assert.ok(index <= 10, `expected <=10, got ${index}`);
    assert.equal(riskLevelFromIndex(index), "low");
  });

  it("stays within 0–100 for extreme input", () => {
    assert.equal(diseaseRiskIndex({ humidity: 200, temperature: 20, rainMm: 500, rainProbabilityPct: 400 }), 100);
    assert.equal(diseaseRiskIndex({ humidity: -50, temperature: -20 }), 0);
  });

  it("rises with humidity, all else equal", () => {
    const dry = diseaseRiskIndex({ humidity: 65, temperature: 20 });
    const humid = diseaseRiskIndex({ humidity: 90, temperature: 20 });
    assert.ok(humid > dry);
  });
});

describe("sprayWindow", () => {
  it("marks a calm dry day as good", () => {
    const w = sprayWindow(day());
    assert.equal(w.suitable, true);
    assert.equal(w.rating, "good");
    assert.deepEqual(w.blockers, []);
  });

  it("blocks rainy days", () => {
    const w = sprayWindow(day({ rainMm: 6, weatherCode: 63 }));
    assert.equal(w.suitable, false);
    assert.ok(w.blockers.includes("rain"));
  });

  it("blocks windy days that would cause drift", () => {
    const w = sprayWindow(day({ windKph: 26 }));
    assert.equal(w.suitable, false);
    assert.ok(w.blockers.includes("wind"));
  });

  it("marks a high-rain-probability but calm day as fair", () => {
    const w = sprayWindow(day({ rainProbabilityPct: 70 }));
    assert.equal(w.rating, "fair");
    assert.equal(w.marginal, true);
  });
});

describe("buildWeatherIntelligence", () => {
  it("flags fungal pressure and finds the next spray window", () => {
    const out = buildWeatherIntelligence({
      current: { temperature: 21, humidity: 92, windSpeed: 6, rainMm: 4 },
      daily: [
        day({ date: "2026-03-01", rainMm: 8, rainProbabilityPct: 85, weatherCode: 63 }),
        day({ date: "2026-03-02", rainMm: 0, rainProbabilityPct: 10, windKph: 7 }),
        day({ date: "2026-03-03" }),
      ],
    });

    assert.equal(out.riskLevel === "high" || out.riskLevel === "severe", true);
    assert.equal(out.nextGoodSprayDate, "2026-03-02");
    const codes = out.advisories.map((a) => a.code);
    assert.ok(codes.includes("fungal_pressure"));
    assert.ok(codes.includes("spray_window"));
  });

  it("recommends irrigation during a dry, hot streak", () => {
    const dryDays = Array.from({ length: 7 }, (_, i) => day({
      date: `2026-07-0${i + 1}`,
      maxTemp: 32,
      rainMm: 0,
      rainProbabilityPct: 5,
    }));
    const out = buildWeatherIntelligence({
      current: { temperature: 31, humidity: 40, windSpeed: 9, rainMm: 0 },
      daily: dryDays,
    });

    assert.equal(out.dryStreakDays, 7);
    assert.ok(out.advisories.some((a) => a.code === "irrigation"));
    assert.equal(out.riskLevel, "low");
  });

  it("warns about drainage when heavy rain is forecast", () => {
    const wetDays = Array.from({ length: 7 }, (_, i) => day({
      date: `2026-04-0${i + 1}`,
      rainMm: 12,
      rainProbabilityPct: 90,
      weatherCode: 65,
    }));
    const out = buildWeatherIntelligence({
      current: { temperature: 19, humidity: 88, windSpeed: 10, rainMm: 10 },
      daily: wetDays,
    });

    assert.ok(out.rain7dMm >= 80);
    assert.equal(out.nextGoodSprayDate, null);
    const codes = out.advisories.map((a) => a.code);
    assert.ok(codes.includes("drainage"));
    assert.ok(codes.includes("no_spray_window"));
  });

  it("survives an empty forecast without throwing", () => {
    const out = buildWeatherIntelligence({});
    assert.equal(typeof out.riskIndex, "number");
    assert.deepEqual(out.sprayWindows, []);
  });
});

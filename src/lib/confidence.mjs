/**
 * Confidence banding shared by the API, the analytics dashboard and the mobile UI.
 *
 * Bands are deliberately conservative: a farmer acting on a wrong diagnosis wastes
 * money on chemicals, so anything under 65% is presented as "confirm before acting".
 */

export const CONFIDENCE_BANDS = {
  high: { min: 85, marginMin: 12 },
  medium: { min: 65, marginMin: 6 },
  low: { min: 45, marginMin: 0 },
};

const ORDER = ["high", "medium", "low", "very_low"];

/**
 * Score picks the band; a thin margin to the runner-up demotes it by exactly one step.
 * (A 92% top class that only beats second place by 3 points means two diseases look
 * alike on this leaf — worth a second photo, not worth discarding.)
 *
 * @param {number} confidencePct 0–100 top-class confidence.
 * @param {number|null|undefined} marginPct gap to the runner-up class, in points.
 * @returns {'high'|'medium'|'low'|'very_low'}
 */
export function confidenceLevel(confidencePct, marginPct = null) {
  const conf = Number.isFinite(confidencePct) ? Math.max(0, Math.min(100, confidencePct)) : 0;
  const margin = Number.isFinite(marginPct) ? marginPct : null;

  let band;
  if (conf >= CONFIDENCE_BANDS.high.min) band = "high";
  else if (conf >= CONFIDENCE_BANDS.medium.min) band = "medium";
  else if (conf >= CONFIDENCE_BANDS.low.min) band = "low";
  else return "very_low";

  const required = CONFIDENCE_BANDS[band].marginMin;
  if (margin !== null && margin < required) {
    return ORDER[Math.min(ORDER.indexOf(band) + 1, ORDER.length - 1)];
  }
  return band;
}

/** Plain-language guidance attached to every stored prediction. */
export function confidenceGuidance(level) {
  switch (level) {
    case "high":
      return {
        en: "High confidence — the model matched this leaf strongly. You can act on the treatment advice.",
        rw: "Ukuri kwinshi — moderi yamenye neza iki kibabi. Ushobora gukurikiza inama zo kuvura.",
      };
    case "medium":
      return {
        en: "Medium confidence — likely correct, but take a second photo of another affected leaf before spraying.",
        rw: "Ukuri kuringaniye — birashoboka ko ari byo, ariko fata indi foto y'ikindi kibabi mbere yo gufumbira.",
      };
    case "low":
      return {
        en: "Low confidence — treat this as a hint only. Re-scan in better light or ask an agronomist.",
        rw: "Ukuri guke — bifate nk'icyerekezo gusa. Ongera usuzume mu mucyo mwiza cyangwa ubaze umujyanama.",
      };
    default:
      return {
        en: "Very low confidence — do not act on this result. Retake the photo with one leaf filling the frame.",
        rw: "Ukuri guke cyane — ntukurikize iki gisubizo. Ongera ufate ifoto y'ikibabi kimwe cyuzuye.",
      };
  }
}

/** True when the result is solid enough to drive a treatment recommendation. */
export function isActionable(level) {
  return level === "high" || level === "medium";
}

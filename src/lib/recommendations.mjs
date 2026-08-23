/**
 * Smart recommendation engine.
 *
 * Combines three signals a farmer already gives us — recent scans, the crop they
 * grow, and the local forecast — into a short, ordered action list. Deterministic
 * by design: the same inputs always produce the same advice, so results can be
 * reviewed by an agronomist and unit-tested.
 */

import { confidenceLevel, isActionable } from "./confidence.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Crop-specific nudges used when nothing more urgent applies. */
const CROP_PRACTICE = {
  tomato: {
    en: "Stake tomato plants and remove the lower leaves touching the soil — that is where blight starts.",
    rw: "Shyigikira inyanya kandi ukureho amababi yo hasi ahura n'ubutaka — ari ho indwara itangirira.",
  },
  potato: {
    en: "Hill soil around potato stems and destroy volunteer plants — they carry blight between seasons.",
    rw: "Sasira ubutaka ku bishishwa by'ibirayi kandi urandure ibimera by'inzererezi — bitwara indwara.",
  },
  maize: {
    en: "Scout the whorl of young maize weekly for fall armyworm before it reaches the cob.",
    rw: "Genzura hagati y'amababi y'ibigori buri cyumweru urebe fall armyworm mbere yuko igera ku ihundo.",
  },
  beans: {
    en: "Rotate beans with a cereal next season and use certified seed to cut root rot.",
    rw: "Simbuza ibishyimbo n'ibinyampeke mu gihembwe gitaha kandi ukoreshe imbuto zemewe.",
  },
  banana: {
    en: "Disinfect your knife between banana mats — one blade spreads wilt across the whole field.",
    rw: "Ozaho icyuma cyawe hagati y'ibitoki — icyuma kimwe gikwirakwiza indwara mu murima wose.",
  },
  cassava: {
    en: "Plant only clean cuttings from healthy mother plants to keep mosaic virus out.",
    rw: "Tera gusa insina zifite ubuzima bwiza kugira ngo wirinde virusi ya mosaic.",
  },
  coffee: {
    en: "Prune coffee for airflow and remove berries left after harvest to break the berry borer cycle.",
    rw: "Ceceka ikawa kugira ngo umwuka unyure kandi ukureho imbuto zasigaye nyuma yo gusarura.",
  },
};

const GENERIC_PRACTICE = {
  en: "Scout your field twice a week and scan any leaf that changes colour — early detection is the cheapest treatment.",
  rw: "Genzura umurima kabiri mu cyumweru kandi usuzume ikibabi cyose gihindutse ibara — kumenya hakiri kare ni byo bihendutse.",
};

/**
 * @param {object} input
 * @param {Array} input.scans recent scans, newest first
 * @param {object|null} input.intelligence output of buildWeatherIntelligence
 * @param {string|null} input.crop crop the farmer is asking about
 * @param {number} input.now epoch ms (injectable for tests)
 * @returns {Array} recommendation drafts (no ids — the caller persists them)
 */
export function buildRecommendations({ scans = [], intelligence = null, crop = null, now = Date.now() } = {}) {
  const out = [];
  const recent = scans.filter((s) => now - s.createdAt <= 30 * DAY_MS);
  const latest = recent[0] ?? null;
  const focusCrop = crop || latest?.crop || null;

  // 1. Act on the most recent diagnosis.
  if (latest) {
    const level = latest.confidenceLevel || confidenceLevel(latest.confidence, latest.marginPct ?? null);
    const isDisease = latest.type === "disease" || latest.type === "pest";

    if (isDisease && isActionable(level)) {
      const timing = intelligence?.nextGoodSprayDate
        ? ` Apply on ${intelligence.nextGoodSprayDate} — the first day with low wind and no rain.`
        : " Spray on the next dry, low-wind morning.";
      const timingRw = intelligence?.nextGoodSprayDate
        ? ` Bikore ku ${intelligence.nextGoodSprayDate} — umunsi wa mbere udafite umuyaga n'imvura.`
        : " Fumbira mu gitondo gikurikira nta mvura n'umuyaga.";

      out.push({
        category: "treatment",
        priority: level === "high" ? "urgent" : "high",
        titleEn: `Treat ${latest.diseaseName} on your ${focusCrop ?? "crop"}`,
        titleRw: `Vura ${latest.diseaseNameRw || latest.diseaseName} ku ${focusCrop ?? "gihingwa"} cyawe`,
        bodyEn:
          `Your scan on ${formatDate(latest.createdAt)} found ${latest.diseaseName} at ${Math.round(latest.confidence)}% confidence. ` +
          `Remove and burn affected leaves first, then treat the whole plot.${timing}`,
        bodyRw:
          `Isuzuma ryawe ryo ku ${formatDate(latest.createdAt)} ryabonye ${latest.diseaseNameRw || latest.diseaseName} kuri ${Math.round(latest.confidence)}%. ` +
          `Banza ukureho amababi arwaye uyatwike, hanyuma uvure umurima wose.${timingRw}`,
        scanId: latest.id,
        crop: focusCrop,
      });
    } else if (isDisease) {
      out.push({
        category: "monitoring",
        priority: "high",
        titleEn: "Re-scan before you buy any chemical",
        titleRw: "Ongera usuzume mbere yo kugura umuti",
        bodyEn:
          `The last scan (${latest.diseaseName}) was only ${Math.round(latest.confidence)}% confident. ` +
          "Take two more photos of different affected leaves in daylight, or send the case to an agronomist before spending money.",
        bodyRw:
          `Isuzuma riheruka (${latest.diseaseNameRw || latest.diseaseName}) ryari kuri ${Math.round(latest.confidence)}% gusa. ` +
          "Fata izindi foto ebyiri z'amababi atandukanye mu mucyo, cyangwa ubaze umujyanama mbere yo gukoresha amafaranga.",
        scanId: latest.id,
        crop: focusCrop,
      });
    } else if (latest.type === "healthy") {
      out.push({
        category: "monitoring",
        priority: "low",
        titleEn: "Crop looks healthy — keep the routine",
        titleRw: "Igihingwa gifite ubuzima bwiza — komeza gutyo",
        bodyEn:
          "Your last scan came back healthy. Keep scanning weekly, especially after rain, so you catch the first spots early.",
        bodyRw:
          "Isuzuma riheruka ryerekanye ubuzima bwiza. Komeza gusuzuma buri cyumweru, cyane cyane nyuma y'imvura.",
        scanId: latest.id,
        crop: focusCrop,
      });
    }
  } else {
    out.push({
      category: "monitoring",
      priority: "medium",
      titleEn: "Run your first scan",
      titleRw: "Kora isuzuma rya mbere",
      bodyEn: "Photograph one leaf that fills the frame in daylight. You get a diagnosis and a treatment plan in seconds.",
      bodyRw: "Fata ifoto y'ikibabi kimwe cyuzuye mu mucyo. Ubona isuzuma n'uburyo bwo kuvura mu masegonda.",
      crop: focusCrop,
    });
  }

  // 2. Repeat outbreak of the same disease — the field, not the leaf, is the problem.
  const repeat = repeatedDisease(recent, now);
  if (repeat) {
    out.push({
      category: "advisory",
      priority: "urgent",
      titleEn: `${repeat.diseaseName} keeps coming back`,
      titleRw: `${repeat.diseaseName} irasubira`,
      bodyEn:
        `You have detected ${repeat.diseaseName} ${repeat.count} times in the last 14 days. Spraying alone will not fix it — ` +
        "rotate this plot to a different crop family next season, widen plant spacing, and have an agronomist inspect the soil.",
      bodyRw:
        `Wabonye ${repeat.diseaseName} inshuro ${repeat.count} mu minsi 14. Gufumbira gusa ntibihagije — ` +
        "simbuza igihingwa mu gihembwe gitaha, wagure intera hagati y'ibimera, kandi usabe umujyanama gusuzuma ubutaka.",
      crop: focusCrop,
    });
  }

  // 3. Weather-driven advice.
  for (const adv of intelligence?.advisories ?? []) {
    out.push({
      category: adv.code === "irrigation" ? "irrigation" : adv.code === "spray_window" ? "spray_window" : "advisory",
      priority: adv.priority,
      titleEn: adv.titleEn,
      titleRw: adv.titleRw,
      bodyEn: adv.bodyEn,
      bodyRw: adv.bodyRw,
      crop: focusCrop,
    });
  }

  // 4. Preventive fungicide when pressure is high and the crop is susceptible.
  if ((intelligence?.riskLevel === "high" || intelligence?.riskLevel === "severe") && isSusceptible(focusCrop)) {
    out.push({
      category: "treatment",
      priority: "high",
      titleEn: `Protect your ${focusCrop} before symptoms appear`,
      titleRw: `Rinda ${focusCrop} mbere y'uko ibimenyetso bigaragara`,
      bodyEn:
        "With this week's humidity, a protectant spray (e.g. copper or mancozeb, following the label and local regulations) " +
        "applied before rain is far cheaper than curing an outbreak.",
      bodyRw:
        "Kubera ubushuhe bw'iki cyumweru, gukoresha umuti wo kurinda (urugero copper cyangwa mancozeb, ukurikije amabwiriza) " +
        "mbere y'imvura birahendutse kurusha kuvura indwara yamaze gukwira.",
      crop: focusCrop,
    });
  }

  // 5. Season-long good practice for the crop.
  const practice = focusCrop ? CROP_PRACTICE[focusCrop] : null;
  const p = practice ?? GENERIC_PRACTICE;
  out.push({
    category: "monitoring",
    priority: "low",
    titleEn: focusCrop ? `Good practice for ${focusCrop}` : "Good scouting practice",
    titleRw: focusCrop ? `Imikorere myiza kuri ${focusCrop}` : "Imikorere myiza yo kugenzura",
    bodyEn: p.en,
    bodyRw: p.rw,
    crop: focusCrop,
  });

  return dedupe(out).sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

function isSusceptible(crop) {
  return ["tomato", "potato", "beans", "coffee", "banana"].includes(crop ?? "");
}

function repeatedDisease(scans, now) {
  const window = scans.filter((s) => now - s.createdAt <= 14 * DAY_MS && (s.type === "disease" || s.type === "pest"));
  const counts = new Map();
  for (const s of window) {
    const key = s.diseaseName || "Unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = null;
  for (const [diseaseName, count] of counts) {
    if (count >= 2 && (!best || count > best.count)) best = { diseaseName, count };
  }
  return best;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((r) => {
    const key = `${r.category}|${r.titleEn}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

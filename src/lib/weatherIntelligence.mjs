/**
 * Local weather intelligence — turns an Open-Meteo forecast into field decisions.
 *
 * Two outputs matter to a farmer:
 *   1. Fungal disease pressure (late blight, leaf spots) for the next few days.
 *   2. When it is actually safe to spray — rain washes product off, wind causes drift.
 *
 * Thresholds follow standard extension guidance for East African highland conditions
 * (leaf wetness + 15–25 °C is the blight window; spray below 20 km/h wind, no rain
 * within ~4 hours). They live here so they can be tuned from one place.
 */

const RAINY_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

export const RISK_BANDS = [
  { max: 24, level: "low" },
  { max: 49, level: "moderate" },
  { max: 74, level: "high" },
  { max: 100, level: "severe" },
];

export function riskLevelFromIndex(index) {
  return RISK_BANDS.find((b) => index <= b.max)?.level ?? "severe";
}

/**
 * Fungal-disease pressure index (0–100) for current conditions.
 * Humidity is the dominant driver, temperature gates the pathogen window,
 * recent/forecast rain adds leaf-wetness hours.
 */
export function diseaseRiskIndex({ humidity, temperature, rainMm = 0, rainProbabilityPct = 0 }) {
  const h = clamp(humidity ?? 0, 0, 100);
  const t = temperature ?? 0;

  // Humidity: nothing below 60%, ramps to full weight at 95%.
  const humidityScore = clamp(((h - 60) / 35) * 45, 0, 45);

  // Temperature: peak risk 15–25 °C, tapering to zero at 5 °C and 35 °C.
  let tempScore = 0;
  if (t >= 15 && t <= 25) tempScore = 30;
  else if (t > 5 && t < 15) tempScore = ((t - 5) / 10) * 30;
  else if (t > 25 && t < 35) tempScore = ((35 - t) / 10) * 30;

  // Wetness: measured rain plus forecast probability.
  const rainScore = clamp((rainMm / 10) * 15, 0, 15) + clamp((rainProbabilityPct / 100) * 10, 0, 10);

  return Math.round(clamp(humidityScore + tempScore + rainScore, 0, 100));
}

/** Spray suitability for one day. */
export function sprayWindow(day) {
  const rain = day.rainMm ?? 0;
  const rainProb = day.rainProbabilityPct ?? 0;
  const wind = day.windKph ?? 0;
  const rainy = RAINY_CODES.has(day.weatherCode ?? -1);

  const blockers = [];
  if (rain >= 2 || rainy) blockers.push("rain");
  if (rainProb >= 60) blockers.push("rain_likely");
  if (wind >= 20) blockers.push("wind");

  const suitable = blockers.length === 0;
  const marginal = !suitable && blockers.every((b) => b === "rain_likely") && wind < 20;

  return {
    date: day.date,
    suitable,
    marginal,
    blockers,
    rating: suitable ? "good" : marginal ? "fair" : "poor",
  };
}

/**
 * Full advisory bundle for a location.
 * @param {object} weather normalized weather payload (see platformApi `/api/weather`).
 */
export function buildWeatherIntelligence(weather) {
  const current = weather?.current ?? {};
  const daily = Array.isArray(weather?.daily) ? weather.daily : [];

  const todayRainProb = daily[0]?.rainProbabilityPct ?? 0;
  const index = diseaseRiskIndex({
    humidity: current.humidity,
    temperature: current.temperature,
    rainMm: current.rainMm ?? daily[0]?.rainMm ?? 0,
    rainProbabilityPct: todayRainProb,
  });
  const level = riskLevelFromIndex(index);

  const windows = daily.slice(0, 7).map(sprayWindow);
  const nextGoodWindow = windows.find((w) => w.suitable) ?? null;

  const rain7 = daily.slice(0, 7).reduce((sum, d) => sum + (d.rainMm ?? 0), 0);
  const dryStreak = countLeadingDryDays(daily);
  const hotDays = daily.slice(0, 5).filter((d) => (d.maxTemp ?? 0) >= 30).length;

  const advisories = [];

  if (level === "high" || level === "severe") {
    advisories.push({
      code: "fungal_pressure",
      priority: level === "severe" ? "urgent" : "high",
      titleEn: "High fungal disease pressure",
      titleRw: "Ibyago byinshi by'indwara z'ibihumyo",
      bodyEn:
        `Humidity ${Math.round(current.humidity ?? 0)}% with ${Math.round(current.temperature ?? 0)}°C keeps leaves wet — ` +
        "ideal for late blight and leaf spot. Scout your field today and remove infected leaves before they spread.",
      bodyRw:
        `Ubushuhe bwa ${Math.round(current.humidity ?? 0)}% na ${Math.round(current.temperature ?? 0)}°C bituma amababi aguma atose — ` +
        "ni ibihe byiza by'indwara. Genzura umurima uyu munsi kandi ukureho amababi arwaye.",
    });
  }

  if (nextGoodWindow) {
    advisories.push({
      code: "spray_window",
      priority: "medium",
      titleEn: `Best spraying day: ${formatDay(nextGoodWindow.date)}`,
      titleRw: `Umunsi mwiza wo gufumbira: ${formatDay(nextGoodWindow.date)}`,
      bodyEn: "Low wind and no rain expected — product will stay on the leaf. Spray early morning or late afternoon.",
      bodyRw: "Umuyaga muke kandi nta mvura iteganyijwe — umuti uzaguma ku kibabi. Fumbira mu gitondo cyangwa nimugoroba.",
    });
  } else {
    advisories.push({
      code: "no_spray_window",
      priority: "medium",
      titleEn: "No good spraying window this week",
      titleRw: "Nta munsi mwiza wo gufumbira muri iki cyumweru",
      bodyEn: "Rain or wind is forecast every day. If you must spray, use a rain-fast product and treat before midday.",
      bodyRw: "Imvura cyangwa umuyaga biteganyijwe buri munsi. Niba ugomba gufumbira, koresha umuti udakurwa n'imvura, ufumbire mbere ya saa sita.",
    });
  }

  if (dryStreak >= 4 || (hotDays >= 3 && rain7 < 5)) {
    advisories.push({
      code: "irrigation",
      priority: "high",
      titleEn: "Dry spell — plan irrigation",
      titleRw: "Igihe cy'izuba — tegura kuhira",
      bodyEn:
        `Only ${rain7.toFixed(1)} mm of rain expected over 7 days. Water early morning at the base of the plant ` +
        "and mulch to hold soil moisture.",
      bodyRw:
        `Hateganyijwe imvura ya ${rain7.toFixed(1)} mm mu minsi 7. Uhire mu gitondo ku gishishwa cy'igihingwa ` +
        "kandi ushyireho ifumbire yo hejuru kugira ngo ubutaka bugume butose.",
    });
  }

  if (rain7 >= 40) {
    advisories.push({
      code: "drainage",
      priority: "medium",
      titleEn: "Heavy rain expected — check drainage",
      titleRw: "Imvura nyinshi iteganyijwe — genzura amazi",
      bodyEn:
        `About ${Math.round(rain7)} mm of rain is forecast this week. Open drainage furrows and avoid working in ` +
        "wet fields — moving between wet plants spreads bacterial and fungal disease.",
      bodyRw:
        `Hateganyijwe imvura ya ${Math.round(rain7)} mm muri iki cyumweru. Fungura imiferege kandi wirinde gukora ` +
        "mu murima utose — kunyura mu bimera bitose bikwirakwiza indwara.",
    });
  }

  return {
    riskIndex: index,
    riskLevel: level,
    rain7dMm: Math.round(rain7 * 10) / 10,
    dryStreakDays: dryStreak,
    sprayWindows: windows,
    nextGoodSprayDate: nextGoodWindow?.date ?? null,
    advisories,
  };
}

function countLeadingDryDays(daily) {
  let n = 0;
  for (const day of daily) {
    if ((day.rainMm ?? 0) < 1 && (day.rainProbabilityPct ?? 0) < 40) n += 1;
    else break;
  }
  return n;
}

function formatDay(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

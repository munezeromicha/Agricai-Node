/**
 * Open-Meteo client with an in-memory cache.
 *
 * Coordinates are rounded to ~1 km before caching so hundreds of farmers in the same
 * village share one upstream call, and the free-tier quota is not burned on GPS noise.
 */

const OPEN_METEO_BASE = () => process.env.OPEN_METEO_BASE?.trim() || "https://api.open-meteo.com/v1/forecast";
const CACHE_TTL_MS = () => (Number(process.env.WEATHER_CACHE_TTL_SEC) || 900) * 1000;
const UPSTREAM_TIMEOUT_MS = 8000;

export const KIGALI = { lat: -1.9403, lon: 30.0588 };

const cache = new Map();

export function roundCoord(n) {
  return Math.round(n * 100) / 100;
}

export function isValidLat(n) {
  return Number.isFinite(n) && n >= -90 && n <= 90;
}

export function isValidLon(n) {
  return Number.isFinite(n) && n >= -180 && n <= 180;
}

/** Normalizes the Open-Meteo payload into the shape the app and the risk model use. */
export function normalizeForecast(data, lat, lon) {
  const current = data.current ?? {};
  const daily = data.daily ?? {};
  const times = Array.isArray(daily.time) ? daily.time : [];

  return {
    latitude: lat,
    longitude: lon,
    fetchedAt: Date.now(),
    current: {
      temperature: current.temperature_2m ?? null,
      humidity: current.relative_humidity_2m ?? null,
      windSpeed: current.wind_speed_10m ?? null,
      rainMm: current.precipitation ?? 0,
      weatherCode: current.weather_code ?? null,
      time: current.time ?? null,
    },
    daily: times.map((date, i) => ({
      date,
      maxTemp: daily.temperature_2m_max?.[i] ?? null,
      minTemp: daily.temperature_2m_min?.[i] ?? null,
      weatherCode: daily.weather_code?.[i] ?? null,
      rainMm: daily.precipitation_sum?.[i] ?? 0,
      rainProbabilityPct: daily.precipitation_probability_max?.[i] ?? 0,
      windKph: daily.wind_speed_10m_max?.[i] ?? 0,
      humidityMaxPct: daily.relative_humidity_2m_max?.[i] ?? null,
    })),
  };
}

/**
 * @returns {Promise<{weather: object, cached: boolean}>}
 * @throws when the upstream call fails and nothing is cached.
 */
export async function getForecast(latRaw, lonRaw) {
  const lat = roundCoord(isValidLat(latRaw) ? latRaw : KIGALI.lat);
  const lon = roundCoord(isValidLon(lonRaw) ? lonRaw : KIGALI.lon);
  const key = `${lat},${lon}`;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return { weather: hit.data, cached: true };
  }

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,relative_humidity_2m_max",
    timezone: "auto",
    forecast_days: "7",
  });

  try {
    const upstream = await fetch(`${OPEN_METEO_BASE()}?${params}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok) throw new Error(`Weather upstream ${upstream.status}`);
    const data = await upstream.json();
    const weather = normalizeForecast(data, lat, lon);
    cache.set(key, { data: weather, expiresAt: Date.now() + CACHE_TTL_MS() });
    return { weather, cached: false };
  } catch (err) {
    // Serve a stale entry rather than nothing — an hour-old forecast still beats a blank screen.
    if (hit) return { weather: hit.data, cached: true, stale: true };
    throw err;
  }
}

/** Test helper. */
export function clearWeatherCache() {
  cache.clear();
}

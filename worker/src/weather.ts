import type { Env } from "./env";
import type { Forecast } from "./rain";

export type Kind = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

export interface Condition { label: string; kind: Kind; icon: string }

// WMO weather interpretation codes, as used by Open-Meteo
export function describeWeather(code: number, isDay = true): Condition {
  if (code === 0) return { label: isDay ? "Sunny" : "Clear", kind: "clear", icon: isDay ? "☀️" : "🌙" };
  if (code === 1) return { label: isDay ? "Mostly sunny" : "Mostly clear", kind: "clear", icon: isDay ? "🌤️" : "🌙" };
  if (code === 2) return { label: "Partly cloudy", kind: "partly", icon: "⛅" };
  if (code === 3) return { label: "Overcast", kind: "cloudy", icon: "☁️" };
  if (code === 45 || code === 48) return { label: "Foggy", kind: "fog", icon: "🌫️" };
  if (code >= 51 && code <= 57) return { label: "Drizzle", kind: "drizzle", icon: "🌦️" };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { label: code >= 80 ? "Showers" : "Rain", kind: "rain", icon: "🌧️" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: "Snow", kind: "snow", icon: "🌨️" };
  if (code >= 95) return { label: "Thunderstorm", kind: "storm", icon: "⛈️" };
  return { label: "Cloudy", kind: "cloudy", icon: "☁️" };
}

export interface WeatherData {
  fetchedAt: number;
  stale?: boolean;
  current: {
    temperatureC: number; feelsLikeC: number; humidityPct: number; windKmh: number; cloudCoverPct: number;
    rainLastHourMm: number; isDay: boolean; isRaining: boolean; condition: Condition;
  };
  past24hMm: number;
  next24hMm: number;
  rainChanceNext24hPct: number;
  etTodayMm?: number; // evapotranspiration: what the garden loses today
  soilMoisture?: number; // modelled, average of the top 28 cm, m3/m3
  daily: { date: string; condition: Condition; tMaxC: number; tMinC: number; rainMm: number; chancePct: number; etMm?: number }[];
}

export interface WeatherBundle { data: WeatherData; forecast: Forecast }

interface OpenMeteo {
  utc_offset_seconds: number;
  current: Record<string, number | string>;
  hourly: {
    time: string[]; precipitation: (number | null)[]; precipitation_probability: (number | null)[];
    temperature_2m?: (number | null)[]; wind_speed_10m?: (number | null)[]; soil_moisture_0_to_7cm?: (number | null)[]; soil_moisture_7_to_28cm?: (number | null)[];
  };
  daily: {
    time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_sum: (number | null)[]; precipitation_probability_max: (number | null)[];
    et0_fao_evapotranspiration?: (number | null)[];
  };
}

const HOUR = 3_600_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function summarizeWeather(raw: OpenMeteo, now: number): WeatherBundle {
  const off = raw.utc_offset_seconds * 1000;
  // hourly times are local wall-clock; convert to epoch ms using the reported offset
  const ts = raw.hourly.time.map((t) => Date.parse(`${t}:00Z`) - off);
  let past = 0, next = 0, chance = 0;
  ts.forEach((t, i) => {
    const mm = raw.hourly.precipitation[i] ?? 0;
    if (t > now - 24 * HOUR && t <= now) past += mm;
    if (t > now && t <= now + 24 * HOUR) {
      next += mm;
      chance = Math.max(chance, raw.hourly.precipitation_probability[i] ?? 0);
    }
  });

  const etByDate: Record<string, number> = {};
  raw.daily.time.forEach((date, i) => {
    const et = raw.daily.et0_fao_evapotranspiration?.[i];
    if (typeof et === "number") etByDate[date] = et;
  });
  const avg = (a?: number | null, b?: number | null) => (typeof a === "number" && typeof b === "number" ? (a + b) / 2 : typeof a === "number" ? a : typeof b === "number" ? b : undefined);
  const nowIdx = ts.reduce((best, t, i) => (t <= now && t > (ts[best] ?? -Infinity) ? i : best), 0);
  const soilNow = avg(raw.hourly.soil_moisture_0_to_7cm?.[nowIdx], raw.hourly.soil_moisture_7_to_28cm?.[nowIdx]);

  const c = raw.current as Record<string, number>;
  const isDay = c.is_day === 1;
  const condition = describeWeather(c.weather_code, isDay);
  const rainLastHourMm = c.precipitation ?? 0;
  const today = String(raw.current.time).slice(0, 10);
  const first = Math.max(0, raw.daily.time.indexOf(today));
  const daily = raw.daily.time.slice(first, first + 7).map((date, k) => {
    const i = first + k;
    return {
      date, condition: describeWeather(raw.daily.weather_code[i]), tMaxC: Math.round(raw.daily.temperature_2m_max[i]),
      tMinC: Math.round(raw.daily.temperature_2m_min[i]), rainMm: round1(raw.daily.precipitation_sum[i] ?? 0), chancePct: raw.daily.precipitation_probability_max[i] ?? 0,
      etMm: etByDate[date] === undefined ? undefined : round1(etByDate[date]),
    };
  });

  return {
    data: {
      fetchedAt: now,
      current: {
        temperatureC: round1(c.temperature_2m), feelsLikeC: round1(c.apparent_temperature), humidityPct: Math.round(c.relative_humidity_2m),
        windKmh: Math.round(c.wind_speed_10m), cloudCoverPct: Math.round(c.cloud_cover), rainLastHourMm: round1(rainLastHourMm), isDay,
        isRaining: rainLastHourMm >= 0.1 || ["drizzle", "rain", "storm"].includes(condition.kind), condition,
      },
      past24hMm: round1(past), next24hMm: round1(next), rainChanceNext24hPct: Math.round(chance),
      etTodayMm: etByDate[today] === undefined ? undefined : round1(etByDate[today]),
      soilMoisture: soilNow === undefined ? undefined : Math.round(soilNow * 100) / 100,
      daily,
    },
    // the same hours in the shape the rain check expects (UTC, no offset)
    forecast: {
      time: ts.map((t) => new Date(t).toISOString().slice(0, 16)),
      precipitation_probability: raw.hourly.precipitation_probability,
      precipitation: raw.hourly.precipitation,
      temperatureC: raw.hourly.temperature_2m,
      windKmh: raw.hourly.wind_speed_10m,
      soilMoistureShallow: raw.hourly.soil_moisture_0_to_7cm,
      soilMoistureDeep: raw.hourly.soil_moisture_7_to_28cm,
      etByDate,
    },
  };
}

const TTL_MS = 5 * 60_000;
let cache: { key: string; at: number; bundle: WeatherBundle } | null = null;

export async function getWeather(env: Env, now = Date.now(), fetchFn: typeof fetch = fetch): Promise<WeatherBundle> {
  const key = `${env.LATITUDE},${env.LONGITUDE},${env.TIMEZONE}`;
  if (cache && cache.key === key && now - cache.at < TTL_MS) return cache.bundle;
  const url = new URL(`${env.WEATHER_BASE_URL ?? "https://api.open-meteo.com"}/v1/forecast`); // the override is for tests
  url.searchParams.set("latitude", env.LATITUDE);
  url.searchParams.set("longitude", env.LONGITUDE);
  url.searchParams.set("timezone", env.TIMEZONE);
  url.searchParams.set("wind_speed_unit", "kmh");
  url.searchParams.set("past_days", "1");
  url.searchParams.set("forecast_days", "7");
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,is_day");
  url.searchParams.set("hourly", "precipitation,precipitation_probability,temperature_2m,wind_speed_10m,soil_moisture_0_to_7cm,soil_moisture_7_to_28cm");
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,et0_fao_evapotranspiration");
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`open-meteo returned ${res.status}`);
    const bundle = summarizeWeather((await res.json()) as OpenMeteo, now);
    cache = { key, at: now, bundle };
    return bundle;
  } catch (e) {
    if (cache && cache.key === key) return { ...cache.bundle, data: { ...cache.bundle.data, stale: true } };
    throw e;
  }
}

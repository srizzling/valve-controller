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

/** What one forecast model says about the weather right now. */
export interface ModelNow { code: number; precipitationMm: number; cloudCoverPct: number | null }

// Open-Meteo's default blend is one model's opinion, and a single model will sometimes drizzle on a clear day. So the
// current conditions are the consensus of several independent ones (the ECMWF run is the same one the blend uses).
const CONSENSUS_MODELS = ["ecmwf_ifs", "gfs_global", "icon_global", "gem_global", "ukmo_global_deterministic_10km", "meteofrance_arpege_world", "jma_gsm"];
const MIN_MODELS = 3; // with fewer answers than this, keep the blend's own reading
const WET: Kind[] = ["drizzle", "rain", "snow", "storm"];

const median = (xs: number[], upper = false) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[upper ? Math.floor(s.length / 2) : Math.ceil(s.length / 2) - 1];
};

/** The majority view of the models: wet only if most of them say so, otherwise the middle of the dry answers. */
export function consensusNow(samples: ModelNow[], isDay: boolean): { condition: Condition; rainMm: number; cloudCoverPct: number | null; wet: boolean; models: number; agreeing: number } | null {
  if (samples.length < MIN_MODELS) return null;
  const wetCodes = samples.filter((s) => WET.includes(describeWeather(s.code).kind)).map((s) => s.code);
  const wet = wetCodes.length * 2 > samples.length;
  const code = wet ? median(wetCodes, true) : median(samples.map((s) => s.code).filter((c) => !wetCodes.includes(c)));
  const clouds = samples.map((s) => s.cloudCoverPct).filter((c): c is number => typeof c === "number");
  return {
    condition: describeWeather(code, isDay), rainMm: median(samples.map((s) => s.precipitationMm)), cloudCoverPct: clouds.length ? median(clouds) : null, wet,
    models: samples.length, agreeing: wet ? wetCodes.length : samples.length - wetCodes.length,
  };
}

export interface WeatherData {
  fetchedAt: number;
  stale?: boolean;
  current: {
    temperatureC: number; feelsLikeC: number; humidityPct: number; windKmh: number; cloudCoverPct: number;
    rainLastHourMm: number; isDay: boolean; isRaining: boolean; condition: Condition;
    consensus?: { models: number; agreeing: number }; // how many models back the condition shown
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

export function summarizeWeather(raw: OpenMeteo, now: number, models: ModelNow[] = []): WeatherBundle {
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
  const agreed = consensusNow(models, isDay);
  const condition = agreed?.condition ?? describeWeather(c.weather_code, isDay);
  const rainLastHourMm = agreed?.rainMm ?? c.precipitation ?? 0;
  const cloudCover = agreed?.cloudCoverPct ?? c.cloud_cover;
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
        windKmh: Math.round(c.wind_speed_10m), cloudCoverPct: Math.round(cloudCover), rainLastHourMm: round1(rainLastHourMm), isDay,
        isRaining: rainLastHourMm >= 0.1 || ["drizzle", "rain", "storm"].includes(condition.kind), condition,
        consensus: agreed ? { models: agreed.models, agreeing: agreed.agreeing } : undefined,
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

// The forecast does not need to be exact, so a copy up to half an hour old is used as is. If Open-Meteo is down,
// a copy up to 6 hours old is shown (marked stale) rather than nothing.
const TTL_MS = 30 * 60_000;
const MAX_STALE_MS = 6 * HOUR;
const STORE_KEY = "weather";

/** Where the last good answer is kept between Worker restarts: the Durable Object's storage. */
export interface WeatherStore { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> }
interface Cached { key: string; at: number; bundle: WeatherBundle }
let cache: Cached | null = null;

let inflight: { key: string; promise: Promise<WeatherBundle> } | null = null;

export async function getWeather(env: Env, now = Date.now(), fetchFn: typeof fetch = fetch, store?: WeatherStore): Promise<WeatherBundle> {
  const key = `${env.LATITUDE},${env.LONGITUDE},${env.TIMEZONE}`;
  // requests that arrive while one is already asking Open-Meteo share its answer
  if (inflight?.key === key) return inflight.promise;
  const promise = load(env, key, now, fetchFn, store);
  inflight = { key, promise };
  try {
    return await promise;
  } finally {
    if (inflight?.promise === promise) inflight = null;
  }
}

/** Asks each model for its current reading. The ones that fail or have no data are left out, never fatal. */
async function fetchModels(env: Env, fetchFn: typeof fetch): Promise<ModelNow[]> {
  const ask = async (model: string): Promise<ModelNow | null> => {
    const url = new URL(`${env.WEATHER_BASE_URL ?? "https://api.open-meteo.com"}/v1/forecast`);
    url.searchParams.set("latitude", env.LATITUDE);
    url.searchParams.set("longitude", env.LONGITUDE);
    url.searchParams.set("timezone", env.TIMEZONE);
    url.searchParams.set("models", model);
    url.searchParams.set("current", "weather_code,precipitation,cloud_cover");
    const res = await fetchFn(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const c = ((await res.json()) as { current?: Record<string, number | null> }).current;
    if (typeof c?.weather_code !== "number" || typeof c.precipitation !== "number") return null;
    return { code: c.weather_code, precipitationMm: c.precipitation, cloudCoverPct: c.cloud_cover ?? null };
  };
  const answers = await Promise.all(CONSENSUS_MODELS.map((m) => ask(m).catch(() => null)));
  return answers.filter((a): a is ModelNow => a !== null);
}

async function load(env: Env, key: string, now: number, fetchFn: typeof fetch, store?: WeatherStore): Promise<WeatherBundle> {
  if (!cache || cache.key !== key) cache = ((await store?.get(STORE_KEY).catch(() => undefined)) as Cached | undefined) ?? null;
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
    // A cold isolate has no cache to fall back on, so one slow answer from Open-Meteo is retried once.
    const fetchRaw = async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetchFn(url, { signal: AbortSignal.timeout(8_000) });
          if (!res.ok) throw new Error(`open-meteo returned ${res.status}`);
          return (await res.json()) as OpenMeteo;
        } catch (e) {
          if (attempt >= 2) throw e;
        }
      }
    };
    const [raw, models] = await Promise.all([fetchRaw(), fetchModels(env, fetchFn)]);
    const bundle = summarizeWeather(raw, now, models);
    cache = { key, at: now, bundle };
    await store?.put(STORE_KEY, cache).catch(() => undefined);
    return bundle;
  } catch (e) {
    if (cache && cache.key === key && now - cache.at < MAX_STALE_MS) return { ...cache.bundle, data: { ...cache.bundle.data, stale: true } };
    throw e;
  }
}

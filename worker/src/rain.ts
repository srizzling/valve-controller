import type { RainConfig } from "./plan";

export interface Forecast {
  time: string[]; // ISO, UTC, no offset ("2026-10-21T04:00")
  precipitation_probability: (number | null)[];
  precipitation: (number | null)[];
  // Extra series for the weather-scaled watering, in the same order as `time`. Optional so the rain check does not care.
  temperatureC?: (number | null)[];
  windKmh?: (number | null)[];
  soilMoistureShallow?: (number | null)[]; // 0 to 7 cm, m3/m3
  soilMoistureDeep?: (number | null)[]; // 7 to 28 cm, m3/m3
  etByDate?: Record<string, number>; // local date "YYYY-MM-DD" -> reference evapotranspiration, mm
}

export interface RainVerdict {
  skip: boolean;
  reason: string;
}

export async function fetchForecast(lat: string, lon: string, fetchFn: typeof fetch = fetch): Promise<Forecast> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("hourly", "precipitation_probability,precipitation");
  url.searchParams.set("forecast_days", "3");
  url.searchParams.set("timezone", "UTC");
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`open-meteo returned ${res.status}`);
  return ((await res.json()) as { hourly: Forecast }).hourly;
}

export function rainVerdict(forecast: Forecast, cfg: RainConfig, now: number): RainVerdict {
  const from = now - 60 * 60 * 1000; // an hourly value covers the hour before its timestamp
  const to = now + cfg.lookaheadHours * 60 * 60 * 1000;
  let maxProb = 0;
  let totalMm = 0;
  let hours = 0;
  forecast.time.forEach((t, i) => {
    const ts = Date.parse(`${t}:00Z`);
    if (ts <= from || ts > to) return;
    hours++;
    maxProb = Math.max(maxProb, forecast.precipitation_probability[i] ?? 0);
    totalMm += forecast.precipitation[i] ?? 0;
  });
  if (hours === 0) throw new Error("forecast does not cover the lookahead window");
  const summary = `${maxProb}% chance, ${totalMm.toFixed(1)} mm in the next ${cfg.lookaheadHours}h`;
  if (maxProb >= cfg.probabilityPct) return { skip: true, reason: `rain likely: ${summary}` };
  if (cfg.mm > 0 && totalMm >= cfg.mm) return { skip: true, reason: `rain forecast: ${summary}` };
  return { skip: false, reason: summary };
}

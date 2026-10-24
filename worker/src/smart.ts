// Weather-scaled watering. Pure functions: the forecast goes in, a cycle count and the reasons come out.
//
// What it does NOT do: it never changes your minutes per cycle or your soak. Those are about how fast your soil takes
// water in. It only changes how many cycles a scheduled run has, and whether the run happens at all.
import type { SmartConfig } from "./plan";
import type { Forecast } from "./rain";

export interface SmartInput {
  etMm?: number; // reference evapotranspiration for the day
  soilMoisture?: number; // modelled, m3/m3
  tempMinC?: number; // coldest hour around the start
  windKmh?: number; // windiest hour around the start
}

export interface SmartPlan {
  run: boolean;
  cycles: number;
  percent: number; // of normal
  reasons: string[]; // plain sentences, shown in the notification and the UI
}

const HOUR = 3_600_000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const avg = (a?: number | null, b?: number | null) => (typeof a === "number" && typeof b === "number" ? (a + b) / 2 : typeof a === "number" ? a : typeof b === "number" ? b : undefined);

export function localDate(ts: number, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
  return p; // en-CA formats as YYYY-MM-DD
}

/** What the forecast says about the weather around `at`, in the shape smartPlan wants. */
export function inputsAt(forecast: Forecast, at: number, timeZone: string): SmartInput {
  const hours = forecast.time.map((t) => Date.parse(`${t}:00Z`));
  const idx = hours.map((t, i) => [t, i] as const);
  // the hour at or just before the start for soil moisture, and the first few hours for temperature and wind
  const before = idx.filter(([t]) => t <= at).at(-1)?.[1];
  const around = idx.filter(([t]) => t > at - HOUR && t <= at + 3 * HOUR).map(([, i]) => i);
  const pick = (series: (number | null)[] | undefined, fn: (...n: number[]) => number) => {
    const vals = around.map((i) => series?.[i]).filter((v): v is number => typeof v === "number");
    return vals.length ? fn(...vals) : undefined;
  };
  return {
    etMm: forecast.etByDate?.[localDate(at, timeZone)],
    soilMoisture: before === undefined ? undefined : avg(forecast.soilMoistureShallow?.[before], forecast.soilMoistureDeep?.[before]),
    tempMinC: pick(forecast.temperatureC, Math.min),
    windKmh: pick(forecast.windKmh, Math.max),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function smartPlan(cfg: SmartConfig, baseCycles: number, input: SmartInput): SmartPlan {
  const skip = (reason: string): SmartPlan => ({ run: false, cycles: 0, percent: 0, reasons: [reason] });

  // Safety gates come first, whether or not scaling is switched on.
  if (cfg.frost.enabled && input.tempMinC !== undefined && input.tempMinC < cfg.frost.belowC) {
    return skip(`Frost risk: ${round1(input.tempMinC)}°C at the start, below your ${cfg.frost.belowC}°C limit.`);
  }
  if (cfg.wind.enabled && input.windKmh !== undefined && input.windKmh > cfg.wind.maxKmh) {
    return skip(`Too windy: ${Math.round(input.windKmh)} km/h at the start, above your ${cfg.wind.maxKmh} km/h limit.`);
  }
  if (!cfg.enabled) return { run: true, cycles: baseCycles, percent: 100, reasons: [] };
  if (input.etMm === undefined) {
    return { run: true, cycles: baseCycles, percent: 100, reasons: ["No evapotranspiration forecast available, so your normal cycles apply."] };
  }

  const etFactor = (input.etMm * cfg.cropFactor) / cfg.referenceEtMm;
  // 1 when the soil is dry, 0 when wet, in between as it dries out. The model remembers recent rain for us.
  const dryness = input.soilMoisture === undefined ? 1 : clamp((cfg.soilWetAbove - input.soilMoisture) / (cfg.soilWetAbove - cfg.soilDryBelow), 0, 1);
  const percent = Math.round(Math.min(cfg.maxPercent, 100 * etFactor * dryness));

  const level = etFactor >= 1.2 ? "Hot, dry day" : etFactor < 0.8 ? "Cool or humid day" : "Typical day";
  const day = `${level} (ET ${round1(input.etMm)} mm, ${Math.round(100 * etFactor)}% of normal)`;
  const soil = input.soilMoisture === undefined ? "" : dryness === 0 ? `, soil wet (${input.soilMoisture.toFixed(2)})` : dryness < 1 ? `, soil damp (${input.soilMoisture.toFixed(2)})` : `, soil dry (${input.soilMoisture.toFixed(2)})`;

  if (percent < cfg.minPercent) {
    return skip(dryness === 0 ? `Soil is wet (${input.soilMoisture!.toFixed(2)} m³/m³), so no watering is needed. ${day}.` : `Low demand: ${day}${soil}. That is ${percent}% of normal, below your ${cfg.minPercent}% minimum.`);
  }
  const cycles = clamp(Math.round((baseCycles * percent) / 100), 1, 20);
  const capped = percent >= cfg.maxPercent ? " (your maximum)" : "";
  const count = cycles === baseCycles ? `${cycles} cycle${cycles === 1 ? "" : "s"}, same as normal` : `${cycles} cycle${cycles === 1 ? "" : "s"} instead of ${baseCycles}`;
  return { run: true, cycles, percent, reasons: [`${day}${soil}. That is ${percent}% of normal${capped}: ${count}.`] };
}

/**
 * Whether an extra run (a start time with "only when ET is at least X mm") is wanted that day.
 * "unknown" when there is no ET figure for the day, which the caller treats as not wanted.
 */
export function extraRunWanted(onlyIfEtMm: number | undefined, etMm: number | undefined): "yes" | "no" | "unknown" {
  if (onlyIfEtMm === undefined) return "yes";
  if (etMm === undefined) return "unknown";
  return etMm >= onlyIfEtMm ? "yes" : "no";
}

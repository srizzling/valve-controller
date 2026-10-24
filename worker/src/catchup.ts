// Making up a run that was skipped for rain that never came. Pure functions: the skipped run and the forecast go in,
// wait, drop or run comes out.

import type { HistoryEntry } from "./controller";
import type { Place, RainConfig } from "./plan";
import { rainVerdict } from "./rain";
import type { Forecast } from "./rain";
import { localDate } from "./smart";
import { sunTimes } from "./sun";

const HOUR = 3_600_000;
const NEXT_RUN_BUFFER_MS = 30 * 60_000; // a make-up run must not land on top of the next scheduled one
const MAX_WAIT_MS = 24 * HOUR;

/** A rain skip waiting to be checked. `checkAt` is when the forecast rain should have fallen, `expiresAt` when to give up. */
export interface CatchUp { skippedAt: number; checkAt: number; expiresAt: number }

export type CatchUpStep = { do: "wait" } | { do: "drop" } | { do: "run"; note: string };

/** Null when the next scheduled run comes before there is anything to check, so that run is the make-up. */
export function newCatchUp(skippedAt: number, rain: RainConfig, nextRun: number | null): CatchUp | null {
  const checkAt = skippedAt + (rain.lookaheadHours + 1) * HOUR;
  const expiresAt = Math.min(skippedAt + MAX_WAIT_MS, nextRun === null ? Infinity : nextRun - NEXT_RUN_BUFFER_MS);
  return expiresAt > checkAt ? { skippedAt, checkAt, expiresAt } : null;
}

const enoughRain = (rain: RainConfig) => (rain.mm > 0 ? rain.mm : 1); // the bar for "the forecast rain came"

function rainSince(forecast: Forecast, since: number, now: number): number | null {
  let total = 0;
  let hours = 0;
  forecast.time.forEach((t, i) => {
    const ts = Date.parse(`${t}:00Z`); // an hourly value covers the hour before its timestamp
    if (ts <= since || ts > now) return;
    hours++;
    total += forecast.precipitation[i] ?? 0;
  });
  return hours === 0 ? null : total;
}

function daylight(now: number, place: Place): boolean {
  const sun = sunTimes(localDate(now, place.timeZone), place.latitude, place.longitude);
  return sun === null || (now >= sun.sunrise && now <= sun.sunset);
}

/**
 * Once the forecast rain was due: if enough fell, drop it, the garden got its water. If not, and it is daylight and the
 * forecast no longer says rain is coming, water. `forecast` is undefined when it could not be fetched, which only waits.
 */
export function catchUpStep(pending: CatchUp, forecast: Forecast | undefined, rain: RainConfig, place: Place, now: number): CatchUpStep {
  if (!rain.enabled || !rain.catchUp || now >= pending.expiresAt) return { do: "drop" };
  if (now < pending.checkAt || !forecast || !daylight(now, place)) return { do: "wait" };
  const fell = rainSince(forecast, pending.skippedAt, now);
  if (fell === null) return { do: "wait" };
  if (fell >= enoughRain(rain)) return { do: "drop" };
  try {
    if (rainVerdict(forecast, rain, now).skip) return { do: "wait" }; // more rain is on the way, so keep waiting
  } catch {
    // no forecast for the window: water anyway, as a scheduled run would
  }
  return { do: "run", note: `Catch-up for the run skipped for rain: only ${fell.toFixed(1)} mm fell.` };
}

/**
 * A scheduled run goes ahead despite a rain forecast when the run before it was skipped for rain and not enough fell
 * since: the garden has gone without, and forecasts keep promising rain that does not come. Returns why, or null.
 * `history` is newest first. Soil that is actually wet still skips the run, so this only overrides the forecast.
 */
export function forcedAfterRainSkip(history: HistoryEntry[], forecast: Forecast, rain: RainConfig, now: number): string | null {
  const last = history[0];
  if (!rain.catchUp || last?.outcome !== "skipped-rain") return null;
  const fell = rainSince(forecast, last.at, now);
  if (fell === null || fell >= enoughRain(rain)) return null;
  return `The last run was skipped for rain and only ${fell.toFixed(1)} mm fell since, so this one goes ahead.`;
}

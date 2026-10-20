import type { HistoryEntry } from "./controller";
import { scheduledRunsOn } from "./plan";
import type { Config } from "./plan";
import { rainVerdict } from "./rain";
import type { Forecast } from "./rain";

export type RunOutlook = "will-run" | "skip" | "unknown" | "done" | "skipped-earlier" | "failed" | "no-record";

export interface PlannedRun {
  at: number;
  state: RunOutlook;
  reason: string;
}

const MATCH_MS = 5 * 60_000;

/**
 * What is expected to happen at each scheduled start on `date`.
 * Future runs get the same rain check the controller will make when they start,
 * using today's forecast, so the answer can change as the forecast does.
 */
export function plannedRuns(config: Config, date: string, forecast: Forecast, history: HistoryEntry[], now: number, timeZone: string): PlannedRun[] {
  return scheduledRunsOn(config, date, timeZone).map((at): PlannedRun => {
    if (at <= now) {
      const h = history.find((e) => e.trigger === "schedule" && Math.abs(e.at - at) < MATCH_MS);
      if (!h) return { at, state: "no-record", reason: "no record of this run" };
      if (h.outcome === "completed") return { at, state: "done", reason: `watered ${Math.round(h.wateredSeconds / 60)} min` };
      if (h.outcome === "skipped-rain") return { at, state: "skipped-earlier", reason: h.note };
      return { at, state: "failed", reason: h.note };
    }
    if (!config.rain.enabled) return { at, state: "will-run", reason: "rain check is off" };
    try {
      const v = rainVerdict(forecast, config.rain, at);
      return { at, state: v.skip ? "skip" : "will-run", reason: v.reason };
    } catch {
      return { at, state: "unknown", reason: "the forecast does not reach this far yet" };
    }
  });
}

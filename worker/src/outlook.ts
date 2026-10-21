import type { HistoryEntry } from "./controller";
import { scheduledRunsOn } from "./plan";
import type { Config, Place } from "./plan";
import { rainVerdict } from "./rain";
import type { Forecast } from "./rain";
import { inputsAt, smartPlan } from "./smart";

export type RunOutlook = "will-run" | "skip" | "skip-weather" | "unknown" | "done" | "skipped-earlier" | "failed" | "no-record";

export interface PlannedRun {
  at: number;
  state: RunOutlook;
  reason: string;
  cycles?: number; // how many cycles it would run, after the weather scaling
  percent?: number; // of your normal cycles
  scaling?: string; // the weather reasoning for the cycle count, when there is one
}

const MATCH_MS = 5 * 60_000;

/**
 * What is expected to happen at each scheduled start on `date`.
 * Future runs get the same checks the controller will make when they start (rain, then the weather scaling and gates),
 * using today's forecast, so the answer can change as the forecast does.
 */
export function plannedRuns(config: Config, date: string, forecast: Forecast, history: HistoryEntry[], now: number, place: Place): PlannedRun[] {
  return scheduledRunsOn(config, date, place).map((at): PlannedRun => {
    if (at <= now) {
      const h = history.find((e) => e.trigger === "schedule" && Math.abs(e.at - at) < MATCH_MS);
      if (!h) return { at, state: "no-record", reason: "no record of this run" };
      if (h.outcome === "completed") return { at, state: "done", reason: `watered ${Math.round(h.wateredSeconds / 60)} min` };
      if (h.outcome === "skipped-rain" || h.outcome === "skipped-weather") return { at, state: "skipped-earlier", reason: h.note };
      return { at, state: "failed", reason: h.note };
    }
    let rainNote = "rain check is off";
    if (config.rain.enabled) {
      try {
        const v = rainVerdict(forecast, config.rain, at);
        if (v.skip) return { at, state: "skip", reason: v.reason };
        rainNote = v.reason;
      } catch {
        return { at, state: "unknown", reason: "the forecast does not reach this far yet" };
      }
    }
    const plan = smartPlan(config.smart, config.cycles, inputsAt(forecast, at, place.timeZone));
    if (!plan.run) return { at, state: "skip-weather", reason: plan.reasons.join(" ") };
    return { at, state: "will-run", reason: [rainNote, ...plan.reasons].join(". "), cycles: plan.cycles, percent: plan.percent, scaling: plan.reasons.join(" ") };
  });
}

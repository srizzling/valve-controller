import type { HistoryEntry } from "./controller";
import { forcedAfterRainSkip } from "./catchup";
import { nextRunAt, scheduledEntriesOn } from "./plan";
import type { Config, Place, ScheduleEntry } from "./plan";
import { rainVerdict } from "./rain";
import type { Forecast } from "./rain";
import { extraRunWanted, inputsAt, smartPlan } from "./smart";

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
 * using today's forecast, so the answer can change as the forecast does. An extra run ("only when ET is at least X")
 * that the forecast says is not needed is left out, because it will not happen.
 */
export function plannedRuns(config: Config, date: string, forecast: Forecast, history: HistoryEntry[], now: number, place: Place): PlannedRun[] {
  const runs: PlannedRun[] = [];
  const next = nextRunAt(config, now, place); // only the next run can be forced; after it there is a fresh record
  const forced = forcedAfterRainSkip(history, forecast, config.rain, now);
  for (const { at, entry } of scheduledEntriesOn(config, date, place)) {
    const run = at <= now ? pastRun(at, entry.onlyIfEtMm !== undefined, history) : futureRun(config, at, entry, forecast, place, at === next ? forced : null);
    if (run) runs.push(run);
  }
  return runs;
}

function pastRun(at: number, isExtra: boolean, history: HistoryEntry[]): PlannedRun | null {
  const h = history.find((e) => e.trigger === "schedule" && Math.abs(e.at - at) < MATCH_MS);
  if (!h) return isExtra ? null : { at, state: "no-record", reason: "no record of this run" }; // an extra run that was not needed leaves no record
  if (h.outcome === "completed") return { at, state: "done", reason: `watered ${Math.round(h.wateredSeconds / 60)} min` };
  if (h.outcome === "skipped-rain" || h.outcome === "skipped-weather") return { at, state: "skipped-earlier", reason: h.note };
  return { at, state: "failed", reason: h.note };
}

function futureRun(config: Config, at: number, entry: ScheduleEntry, forecast: Forecast, place: Place, forced: string | null): PlannedRun | null {
  const input = inputsAt(forecast, at, place.timeZone);
  if (entry.onlyIfEtMm !== undefined) {
    const want = extraRunWanted(entry.onlyIfEtMm, input.etMm);
    if (want === "no") return null;
    if (want === "unknown") return { at, state: "unknown", reason: `the forecast does not reach this far yet (extra run: only when ET is ${entry.onlyIfEtMm} mm or more)` };
  }
  let rainNote = "rain check is off";
  if (config.rain.enabled) {
    try {
      const v = rainVerdict(forecast, config.rain, at);
      if (v.skip && !forced) return { at, state: "skip", reason: v.reason };
      rainNote = v.skip ? `${v.reason}. ${forced}` : v.reason;
    } catch {
      return { at, state: "unknown", reason: "the forecast does not reach this far yet" };
    }
  }
  const plan = smartPlan(config.smart, config.cycles, input);
  if (!plan.run) return { at, state: "skip-weather", reason: plan.reasons.join(" ") };
  return { at, state: "will-run", reason: [rainNote, ...plan.reasons].join(". "), cycles: plan.cycles, percent: plan.percent, scaling: plan.reasons.join(" ") };
}

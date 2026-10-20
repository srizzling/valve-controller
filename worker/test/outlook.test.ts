import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../src/controller";
import { plannedRuns } from "../src/outlook";
import { defaultConfig, scheduledRunsOn } from "../src/plan";
import type { Forecast } from "../src/rain";

const HOUR = 3_600_000;
const tz = "Australia/Melbourne"; // UTC+11 in October
const config = { ...defaultConfig, schedules: [{ days: [3, 4], time: "06:00" }], rain: { enabled: true, probabilityPct: 50, mm: 1, lookaheadHours: 6 } };
// Wed 2026-10-21 05:00 local = 2026-10-20 18:00 UTC
const now = Date.UTC(2026, 9, 20, 18, 0);
const run = (date: string) => scheduledRunsOn(config, date, tz)[0];

function forecast(rainyAt?: number): Forecast {
  const time: string[] = [], prob: number[] = [], mm: number[] = [];
  for (let h = -24; h < 24 * 7; h++) {
    const t = now + h * HOUR;
    time.push(new Date(t).toISOString().slice(0, 16));
    const wet = rainyAt !== undefined && Math.abs(t - rainyAt) <= 2 * HOUR;
    prob.push(wet ? 90 : 5);
    mm.push(wet ? 3 : 0);
  }
  return { time, precipitation_probability: prob, precipitation: mm };
}

describe("scheduledRunsOn", () => {
  it("lists runs only on scheduled weekdays, in local time", () => {
    expect(scheduledRunsOn(config, "2026-10-21", tz)).toEqual([Date.UTC(2026, 9, 20, 19, 0)]); // Wed
    expect(scheduledRunsOn(config, "2026-10-23", tz)).toEqual([]); // Fri
    expect(scheduledRunsOn({ ...config, enabled: false }, "2026-10-21", tz)).toEqual([]);
  });
});

describe("plannedRuns", () => {
  it("will run on a dry day and skip on a wet one", () => {
    const wetThursday = run("2026-10-22") + 1 * HOUR;
    expect(plannedRuns(config, "2026-10-21", forecast(wetThursday), [], now, tz)[0].state).toBe("will-run");
    expect(plannedRuns(config, "2026-10-22", forecast(wetThursday), [], now, tz)[0].state).toBe("skip");
  });
  it("has nothing on unscheduled days", () => {
    expect(plannedRuns(config, "2026-10-24", forecast(), [], now, tz)).toEqual([]);
  });
  it("ignores the forecast when the rain check is off", () => {
    const c = { ...config, rain: { ...config.rain, enabled: false } };
    expect(plannedRuns(c, "2026-10-22", forecast(run("2026-10-22")), [], now, tz)[0]).toMatchObject({ state: "will-run", reason: "rain check is off" });
  });
  it("is unknown past the end of the forecast", () => {
    expect(plannedRuns(config, "2026-11-12", forecast(), [], now, tz)[0].state).toBe("unknown");
  });
  it("reports what actually happened for runs that are already past", () => {
    const at = run("2026-10-21");
    const later = at + 30 * 60_000;
    const done: HistoryEntry = { at, trigger: "schedule", outcome: "completed", wateredSeconds: 1800, note: "3 cycles" };
    const skipped: HistoryEntry = { at: at + 20_000, trigger: "schedule", outcome: "skipped-rain", wateredSeconds: 0, note: "rain likely" };
    const manual: HistoryEntry = { ...done, trigger: "manual" };
    expect(plannedRuns(config, "2026-10-21", forecast(), [done], later, tz)[0]).toMatchObject({ state: "done" });
    expect(plannedRuns(config, "2026-10-21", forecast(), [skipped], later, tz)[0]).toMatchObject({ state: "skipped-earlier", reason: "rain likely" });
    expect(plannedRuns(config, "2026-10-21", forecast(), [manual], later, tz)[0].state).toBe("no-record");
    expect(plannedRuns(config, "2026-10-21", forecast(), [], later, tz)[0].state).toBe("no-record");
  });
});

import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../src/controller";
import { plannedRuns } from "../src/outlook";
import { defaultConfig, scheduledRunsOn } from "../src/plan";
import type { Forecast } from "../src/rain";

const HOUR = 3_600_000;
const tz = { timeZone: "Australia/Melbourne", latitude: -37.72, longitude: 145 }; // UTC+11 in October
const config = { ...defaultConfig, schedules: [{ days: [3, 4], time: "06:00" }], rain: { enabled: true, probabilityPct: 50, mm: 1, lookaheadHours: 6, catchUp: true } };
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
    expect(plannedRuns(c, "2026-10-22", forecast(run("2026-10-22")), [], now, tz)[0]).toMatchObject({ state: "will-run", reason: expect.stringContaining("rain check is off") });
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

describe("plannedRuns with weather scaling", () => {
  // the Thursday run is at 06:00 local = 19:00 UTC Wed. Build a forecast whose ET, soil and wind we control.
  const runAt = Date.UTC(2026, 9, 21, 19, 0);
  const mk = (extra: Partial<Forecast>): Forecast => {
    const time: string[] = [], prob: number[] = [], mm: number[] = [];
    for (let h = -24; h < 24 * 6; h++) {
      time.push(new Date(now + h * HOUR).toISOString().slice(0, 16));
      prob.push(5);
      mm.push(0);
    }
    const flat = (v: number) => time.map(() => v);
    return { time, precipitation_probability: prob, precipitation: mm, temperatureC: flat(12), windKmh: flat(8), soilMoistureShallow: flat(0.15), soilMoistureDeep: flat(0.2), etByDate: { "2026-10-22": 4.5 }, ...extra };
  };

  it("reports the planned cycles and how they were worked out", () => {
    const hot = mk({ etByDate: { "2026-10-22": 6.2 } });
    const [r] = plannedRuns(config, "2026-10-22", hot, [], now, tz);
    expect(r).toMatchObject({ state: "will-run", cycles: 4, percent: 138 });
    expect(r.reason).toMatch(/hot, dry day/i);
  });

  it("flags a day skipped for the weather: wet soil, wind or frost", () => {
    const wet = mk({ soilMoistureShallow: Array(24 * 7).fill(0.45), soilMoistureDeep: Array(24 * 7).fill(0.45) });
    expect(plannedRuns(config, "2026-10-22", wet, [], now, tz)[0]).toMatchObject({ state: "skip-weather" });
    const windy = mk({ windKmh: Array(24 * 7).fill(45) });
    expect(plannedRuns(config, "2026-10-22", windy, [], now, tz)[0].reason).toMatch(/too windy/i);
    const frosty = mk({ temperatureC: Array(24 * 7).fill(-1) });
    expect(plannedRuns(config, "2026-10-22", frosty, [], now, tz)[0].reason).toMatch(/frost/i);
  });

  it("checks rain before the weather scaling", () => {
    const wetAndRainy = mk({ precipitation_probability: Array(24 * 7).fill(90), precipitation: Array(24 * 7).fill(2) });
    expect(plannedRuns(config, "2026-10-22", wetAndRainy, [], now, tz)[0].state).toBe("skip");
  });

  describe("an extra run that only happens on a hot day", () => {
    const withExtra = { ...config, schedules: [{ days: [4], time: "06:00" }, { days: [4], time: "18:00", onlyIfEtMm: 6 }] }; // Thursday
    it("is in the outlook when ET reaches the limit", () => {
      const runs = plannedRuns(withExtra, "2026-10-22", mk({ etByDate: { "2026-10-22": 6.2 } }), [], now, tz);
      expect(runs).toHaveLength(2);
      expect(runs.every((r) => r.state === "will-run")).toBe(true);
    });
    it("is left out when the day is not hot enough", () => {
      const runs = plannedRuns(withExtra, "2026-10-22", mk({ etByDate: { "2026-10-22": 5.9 } }), [], now, tz);
      expect(runs).toHaveLength(1);
    });
    it("is shown as not forecast yet when there is no ET for that day", () => {
      const runs = plannedRuns(withExtra, "2026-10-22", mk({ etByDate: {} }), [], now, tz);
      expect(runs[1]).toMatchObject({ state: "unknown" });
      expect(runs[1].reason).toMatch(/6 mm or more/);
    });
    it("leaves no 'no record' behind for a past extra run that did not happen", () => {
      const later = Date.UTC(2026, 9, 22, 12, 0); // Thursday 23:00 local, both starts have passed
      const runs = plannedRuns(withExtra, "2026-10-22", mk({}), [], later, tz);
      expect(runs.map((r) => r.state)).toEqual(["no-record"]);
    });
  });

  it("treats a past run skipped for the weather as skipped, not as missing", () => {
    const at = runAt - 24 * HOUR;
    const entry: HistoryEntry = { at, trigger: "schedule", outcome: "skipped-weather", wateredSeconds: 0, note: "Soil is wet" };
    expect(plannedRuns(config, "2026-10-21", mk({}), [entry], runAt, tz)[0]).toMatchObject({ state: "skipped-earlier", reason: "Soil is wet" });
  });

  it("starts at dawn when the schedule says so", () => {
    const dawn = { ...config, schedules: [{ days: [3, 4], at: "dawn" as const, time: "00:00", beforeSunriseMin: 45 }] };
    const [r] = plannedRuns(dawn, "2026-10-22", mk({}), [], now, tz);
    // sunrise at the garden on 22 Oct is about 06:25 local, so 45 min earlier is about 05:40 local (18:40 UTC the day before)
    expect(Math.abs(r.at - Date.UTC(2026, 9, 21, 18, 40))).toBeLessThan(5 * 60_000);
  });
});

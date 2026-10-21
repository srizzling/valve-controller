import { describe, expect, it } from "vitest";
import { advance, defaultConfig, dueEntry, dueSchedule, idleState, nextRunAt, normalizeConfig, scheduledRunsOn, startRun, validateConfig, wateredSoFar } from "../src/plan";
import { sunTimes } from "../src/sun";
import { rainVerdict } from "../src/rain";
import type { Forecast } from "../src/rain";
import { signToken, verifyToken } from "../src/google";

const MIN = 60_000;
const place = { timeZone: "Australia/Melbourne", latitude: -37.72, longitude: 145 };
const config = { ...defaultConfig, onMinutes: 10, soakMinutes: 5, cycles: 3 };

describe("cycle and soak", () => {
  it("runs 10 on / 5 off for 3 cycles, ending after the last watering period", () => {
    const t0 = Date.UTC(2026, 9, 21, 20, 0);
    let state = startRun(config, "schedule", t0);
    expect(state).toMatchObject({ phase: "watering", cycle: 1, phaseEndsAt: t0 + 10 * MIN });

    const seen: string[] = [];
    let now = t0;
    for (let i = 0; i < 10; i++) {
      now = state.phaseEndsAt;
      const step = advance(state, now);
      seen.push(`${now - t0 > 0 ? (now - t0) / MIN : 0}:${step.valve}${step.finished ? ":done" : ""}`);
      state = step.next;
      if (step.finished) break;
    }
    // watering ends at 10 (close), soak ends at 15 (open), 25 (close), 30 (open), 40 (close, done)
    expect(seen).toEqual(["10:close", "15:open", "25:close", "30:open", "40:close:done"]);
    expect(state.phase).toBe("idle");
    expect(state.wateredSeconds).toBe(30 * 60);
  });

  it("with no soak it stays open between cycles", () => {
    const state = startRun({ ...config, soakMinutes: 0, cycles: 2 }, "manual", 0);
    const step = advance(state, state.phaseEndsAt);
    expect(step.valve).toBe("open");
    expect(step.next).toMatchObject({ phase: "watering", cycle: 2 });
  });

  it("snapshots the plan at start", () => {
    const state = startRun(config, "manual", 0);
    expect(state.onSeconds).toBe(600);
    expect(state.soakSeconds).toBe(300);
  });

  it("counts partial watering time when stopped", () => {
    const state = startRun(config, "manual", 0);
    expect(wateredSoFar(state, 3 * MIN)).toBe(180);
    const soaking = advance(state, 10 * MIN).next;
    expect(wateredSoFar(soaking, 12 * MIN)).toBe(600);
  });
});

describe("schedule", () => {
  const cfg = { ...config, schedules: [{ days: [3], time: "06:00" }] };
  it("fires at the local time on the right weekday", () => {
    // 2026-10-21 is a Wednesday; 06:00 in Melbourne (UTC+11 in October) is 19:00 UTC the day before
    const due = Date.UTC(2026, 9, 20, 19, 0);
    expect(dueSchedule(cfg, due, place)).toBe("2026-10-21 06:00");
    expect(dueSchedule(cfg, due + MIN, place)).toBeNull();
    expect(dueSchedule(cfg, due + 24 * 60 * MIN, place)).toBeNull(); // Thursday
  });
  it("does nothing when disabled", () => {
    expect(dueSchedule({ ...cfg, enabled: false }, Date.UTC(2026, 9, 20, 19, 0), place)).toBeNull();
  });
});

describe("config validation", () => {
  it("accepts the default", () => expect(validateConfig(defaultConfig)).toEqual(defaultConfig));
  it("rejects nonsense", () => {
    expect(() => validateConfig({ ...defaultConfig, onMinutes: 0 })).toThrow();
    expect(() => validateConfig({ ...defaultConfig, cycles: 100 })).toThrow();
    expect(() => validateConfig({ ...defaultConfig, schedules: [{ days: [9], time: "06:00" }] })).toThrow();
    expect(() => validateConfig({ ...defaultConfig, schedules: [{ days: [1], time: "6am" }] })).toThrow();
    expect(() => validateConfig(null)).toThrow();
  });
});

describe("rain verdict", () => {
  const now = Date.UTC(2026, 9, 20, 19, 0);
  const hour = (h: number) => new Date(now + h * 60 * MIN).toISOString().slice(0, 16);
  const forecast = (prob: number[], mm: number[]): Forecast => ({
    time: prob.map((_, i) => hour(i)), precipitation_probability: prob, precipitation: mm,
  });
  const rain = { enabled: true, probabilityPct: 50, mm: 1, lookaheadHours: 3 };

  it("waters on a dry forecast", () => expect(rainVerdict(forecast([0, 10, 20, 30, 90], [0, 0, 0, 0, 5]), rain, now).skip).toBe(false));
  it("skips on high probability", () => expect(rainVerdict(forecast([0, 60, 0, 0], [0, 0, 0, 0]), rain, now).skip).toBe(true));
  it("skips on enough accumulated rain", () => expect(rainVerdict(forecast([10, 10, 10, 10], [0, 0.6, 0.6, 0]), rain, now).skip).toBe(true));
  it("ignores rain beyond the lookahead window", () => expect(rainVerdict(forecast([0, 0, 0, 0, 100], [0, 0, 0, 0, 9]), rain, now).skip).toBe(false));
  it("errors when the forecast has no data in range", () => expect(() => rainVerdict({ time: [], precipitation_probability: [], precipitation: [] }, rain, now)).toThrow());
});

describe("signed tokens", () => {
  it("round-trips, and rejects tampering, wrong type and expiry", async () => {
    const t = await signToken("k", { typ: "access", exp: 1000 });
    expect(await verifyToken("k", t, "access", 999)).toMatchObject({ typ: "access" });
    expect(await verifyToken("k", t, "access", 1001)).toBeNull();
    expect(await verifyToken("k", t, "refresh", 999)).toBeNull();
    expect(await verifyToken("other", t, "access", 999)).toBeNull();
    expect(await verifyToken("k", t.slice(0, -2) + "xx", "access", 999)).toBeNull();
  });
});

describe("healthchecks urls", () => {
  it("builds start/ok/fail urls and tolerates a trailing slash", async () => {
    const { pingUrl } = await import("../src/heartbeat");
    expect(pingUrl("https://hc-ping.com/abc", "ok")).toBe("https://hc-ping.com/abc");
    expect(pingUrl("https://hc-ping.com/abc/", "start")).toBe("https://hc-ping.com/abc/start");
    expect(pingUrl("https://hc-ping.com/abc", "fail")).toBe("https://hc-ping.com/abc/fail");
  });
});

describe("dawn schedule", () => {
  const dawn = { ...config, schedules: [{ days: [0, 1, 2, 3, 4, 5, 6], at: "dawn" as const, time: "00:00", beforeSunriseMin: 30 }] };
  const sunrise = (date: string) => sunTimes(date, place.latitude, place.longitude)!.sunrise;
  const dawnStart = (date: string) => Math.floor((sunrise(date) - 30 * MIN) / MIN) * MIN;

  it("is due exactly the minute that is 30 minutes before sunrise", () => {
    const at = dawnStart("2026-10-22");
    expect(dueSchedule(dawn, at, place)).toMatch(/^2026-10-22 0[5-6]:\d\d$/);
    expect(dueSchedule(dawn, at - MIN, place)).toBeNull();
    expect(dueSchedule(dawn, at + MIN, place)).toBeNull();
  });

  it("moves with the seasons", () => {
    const summer = scheduledRunsOn(dawn, "2026-12-21", place)[0];
    const winter = scheduledRunsOn(dawn, "2026-06-21", place)[0];
    const localHour = (t: number) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: place.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t)).slice(0, 2));
    expect(localHour(summer)).toBeLessThan(localHour(winter)); // earlier in summer
  });

  it("finds the next dawn start", () => {
    const now = Date.UTC(2026, 9, 21, 12, 0); // midday on the 21st local
    expect(nextRunAt(dawn, now, place)).toBe(dawnStart("2026-10-22"));
  });

  it("skips a day with no sunrise instead of failing", () => {
    const polar = { timeZone: "Arctic/Longyearbyen", latitude: 78.2, longitude: 15.6 };
    expect(scheduledRunsOn(dawn, "2026-12-21", polar)).toEqual([]);
  });

  it("still handles ordinary clock entries alongside", () => {
    const both = { ...config, schedules: [{ days: [3], time: "06:00" }, { days: [3], at: "dawn" as const, time: "00:00", beforeSunriseMin: 0 }] };
    expect(scheduledRunsOn(both, "2026-10-21", place)).toHaveLength(2);
  });
});

describe("sunset schedule", () => {
  const sunset = (date: string) => sunTimes(date, place.latitude, place.longitude)!.sunset;
  const dusk = (min: number) => ({ ...config, schedules: [{ days: [0, 1, 2, 3, 4, 5, 6], at: "dusk" as const, time: "00:00", afterSunsetMin: min }] });

  it("is due exactly the minute it is 45 minutes before sunset", () => {
    const at = Math.floor((sunset("2026-10-22") - 45 * MIN) / MIN) * MIN;
    expect(dueSchedule(dusk(-45), at, place)).toMatch(/^2026-10-22 1[78]:\d\d$/);
    expect(dueSchedule(dusk(-45), at - MIN, place)).toBeNull();
  });

  it("can start after sunset", () => {
    const [t] = scheduledRunsOn(dusk(20), "2026-10-22", place);
    expect(t).toBe(Math.floor((sunset("2026-10-22") + 20 * MIN) / MIN) * MIN);
  });

  it("gives a sunrise and a sunset run on the same day, earliest first", () => {
    const both = { ...config, schedules: [
      { days: [3], at: "dusk" as const, time: "00:00", afterSunsetMin: -30 },
      { days: [3], at: "dawn" as const, time: "00:00", beforeSunriseMin: 30 },
    ] };
    const [first, second] = scheduledRunsOn(both, "2026-10-21", place);
    expect(first).toBeLessThan(second);
    expect(second - first).toBeGreaterThan(10 * 3_600_000);
    expect(nextRunAt(both, Date.UTC(2026, 9, 21, 0, 0), place)).toBe(second); // 11:00 local: the sunrise start has passed, the sunset one has not
  });

  it("validates the offset and keeps no clock time", () => {
    expect(() => validateConfig({ ...defaultConfig, schedules: [{ days: [1], at: "dusk", time: "00:00", afterSunsetMin: 300 }] })).toThrow(/afterSunsetMin/);
    const c = validateConfig({ ...defaultConfig, schedules: [{ days: [1], at: "dusk", time: "ignored", afterSunsetMin: -30 }] });
    expect(c.schedules[0]).toEqual({ days: [1], at: "dusk", time: "00:00", afterSunsetMin: -30 });
  });
});

describe("extra runs", () => {
  it("returns the entry that is due, with its ET condition", () => {
    const cfg = { ...config, schedules: [{ days: [3], time: "06:00" }, { days: [3], time: "18:00", onlyIfEtMm: 6 }] };
    const evening = Date.UTC(2026, 9, 21, 7, 0); // Wed 18:00 Melbourne (UTC+11)
    expect(dueEntry(cfg, evening, place)).toMatchObject({ key: "2026-10-21 18:00", entry: { onlyIfEtMm: 6 } });
    expect(dueEntry(cfg, evening - 12 * 3_600_000, place)?.entry.onlyIfEtMm).toBeUndefined();
  });

  it("validates and keeps the ET limit", () => {
    const sched = (onlyIfEtMm: number) => ({ ...defaultConfig, schedules: [{ days: [1], at: "clock", time: "18:00", onlyIfEtMm }] });
    expect(() => validateConfig(sched(0.1))).toThrow(/onlyIfEtMm/);
    expect(() => validateConfig(sched(50))).toThrow(/onlyIfEtMm/);
    expect(validateConfig(sched(6)).schedules[0].onlyIfEtMm).toBe(6);
    expect(validateConfig({ ...defaultConfig, schedules: [{ days: [1], at: "clock", time: "18:00" }] }).schedules[0]).not.toHaveProperty("onlyIfEtMm");
  });
});

describe("saved configs and the new settings", () => {
  it("fills in the weather settings for a config saved before they existed", () => {
    const old = { enabled: true, onMinutes: 10, soakMinutes: 5, cycles: 3, schedules: [{ days: [1], time: "06:00" }], rain: { enabled: true, probabilityPct: 50, mm: 1, lookaheadHours: 6 } };
    const c = normalizeConfig(old);
    expect(c.smart).toEqual(defaultConfig.smart);
    expect(c.schedules[0]).toMatchObject({ at: "clock", time: "06:00" });
    expect(validateConfig(old).smart).toEqual(defaultConfig.smart);
  });

  it("keeps the settings you changed and fills only what is missing", () => {
    const c = normalizeConfig({ ...defaultConfig, smart: { maxPercent: 120, wind: { maxKmh: 20 } } });
    expect(c.smart.maxPercent).toBe(120);
    expect(c.smart.wind).toEqual({ enabled: true, maxKmh: 20 });
    expect(c.smart.referenceEtMm).toBe(defaultConfig.smart.referenceEtMm);
  });

  it("rejects nonsense in the weather settings and dawn entries", () => {
    const bad = (smart: object) => () => validateConfig({ ...defaultConfig, smart: { ...defaultConfig.smart, ...smart } });
    expect(bad({ referenceEtMm: 0 })).toThrow(/referenceEtMm/);
    expect(bad({ cropFactor: 5 })).toThrow(/cropFactor/);
    expect(bad({ maxPercent: 10 })).toThrow(/maxPercent/);
    expect(bad({ soilDryBelow: 0.4, soilWetAbove: 0.3 })).toThrow(/soilWetAbove/);
    expect(bad({ minPercent: 80, maxPercent: 60 })).toThrow();
    expect(() => validateConfig({ ...defaultConfig, schedules: [{ days: [1], at: "dawn", time: "00:00", beforeSunriseMin: 500 }] })).toThrow(/beforeSunriseMin/);
    expect(() => validateConfig({ ...defaultConfig, schedules: [{ days: [1], at: "noon", time: "12:00" }] })).toThrow(/schedule type/);
  });

  it("keeps a valid dawn entry without a clock time", () => {
    const c = validateConfig({ ...defaultConfig, schedules: [{ days: [2, 1, 1], at: "dawn", time: "ignored", beforeSunriseMin: 20 }] });
    expect(c.schedules[0]).toEqual({ days: [1, 2], at: "dawn", time: "00:00", beforeSunriseMin: 20 });
  });

  it("lets startRun override the number of cycles without touching the minutes", () => {
    const run = startRun(defaultConfig, "schedule", 0, 5);
    expect(run).toMatchObject({ cycles: 5, onSeconds: 600, soakSeconds: 300 });
  });
});

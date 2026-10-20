import { describe, expect, it } from "vitest";
import { advance, defaultConfig, dueSchedule, idleState, startRun, validateConfig, wateredSoFar } from "../src/plan";
import { rainVerdict } from "../src/rain";
import type { Forecast } from "../src/rain";
import { signToken, verifyToken } from "../src/google";

const MIN = 60_000;
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
    expect(dueSchedule(cfg, due, "Australia/Melbourne")).toBe("2026-10-21 06:00");
    expect(dueSchedule(cfg, due + MIN, "Australia/Melbourne")).toBeNull();
    expect(dueSchedule(cfg, due + 24 * 60 * MIN, "Australia/Melbourne")).toBeNull(); // Thursday
  });
  it("does nothing when disabled", () => {
    expect(dueSchedule({ ...cfg, enabled: false }, Date.UTC(2026, 9, 20, 19, 0), "Australia/Melbourne")).toBeNull();
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

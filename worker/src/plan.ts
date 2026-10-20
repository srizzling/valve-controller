// Pure scheduling logic. No I/O, so it is easy to test.

export interface ScheduleEntry {
  days: number[]; // 0 = Sunday ... 6 = Saturday
  time: string; // "HH:MM" in the configured timezone
}

export interface RainConfig {
  enabled: boolean;
  probabilityPct: number; // skip if any hour in the window is at or above this
  mm: number; // skip if forecast total in the window is at or above this
  lookaheadHours: number;
}

export interface Config {
  enabled: boolean;
  onMinutes: number;
  soakMinutes: number;
  cycles: number;
  schedules: ScheduleEntry[];
  rain: RainConfig;
}

export const defaultConfig: Config = {
  enabled: true,
  onMinutes: 10,
  soakMinutes: 5,
  cycles: 3,
  schedules: [{ days: [0, 1, 2, 3, 4, 5, 6], time: "06:00" }],
  rain: { enabled: true, probabilityPct: 50, mm: 1, lookaheadHours: 6 },
};

export type Trigger = "schedule" | "manual" | "google";

export interface RunState {
  phase: "idle" | "watering" | "soaking";
  trigger: Trigger;
  cycle: number; // 1-based, the cycle currently in progress
  cycles: number;
  onSeconds: number; // snapshot of the plan so editing settings mid-run changes nothing
  soakSeconds: number;
  startedAt: number; // epoch ms
  phaseStartedAt: number;
  phaseEndsAt: number;
  wateredSeconds: number;
  attempts: number; // consecutive failed attempts to move to the next phase
}

export const idleState: RunState = {
  phase: "idle",
  trigger: "manual",
  cycle: 0,
  cycles: 0,
  onSeconds: 0,
  soakSeconds: 0,
  startedAt: 0,
  phaseStartedAt: 0,
  phaseEndsAt: 0,
  wateredSeconds: 0,
  attempts: 0,
};

export function validateConfig(input: unknown): Config {
  const c = input as Partial<Config> | null;
  if (!c || typeof c !== "object") throw new Error("config must be an object");
  const int = (v: unknown, name: string, min: number, max: number) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      throw new Error(`${name} must be a number between ${min} and ${max}`);
    }
    return v;
  };
  const rain = (c.rain ?? {}) as Partial<RainConfig>;
  const schedules = c.schedules;
  if (!Array.isArray(schedules) || schedules.length > 20) throw new Error("schedules must be a list of up to 20 entries");
  for (const s of schedules) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s?.time)) throw new Error(`bad schedule time: ${s?.time}`);
    if (!Array.isArray(s.days) || s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new Error("schedule days must be integers 0-6");
    }
  }
  return {
    enabled: c.enabled !== false,
    onMinutes: int(c.onMinutes, "onMinutes", 0.1, 60),
    soakMinutes: int(c.soakMinutes, "soakMinutes", 0, 240),
    cycles: int(c.cycles, "cycles", 1, 20),
    schedules: schedules.map((s) => ({ days: [...new Set(s.days)].sort(), time: s.time })),
    rain: {
      enabled: rain.enabled !== false,
      probabilityPct: int(rain.probabilityPct, "rain.probabilityPct", 0, 100),
      mm: int(rain.mm, "rain.mm", 0, 100),
      lookaheadHours: int(rain.lookaheadHours, "rain.lookaheadHours", 1, 48),
    },
  };
}

export function startRun(config: Config, trigger: Trigger, now: number): RunState {
  const onSeconds = Math.round(config.onMinutes * 60);
  return {
    phase: "watering",
    trigger,
    cycle: 1,
    cycles: config.cycles,
    onSeconds,
    soakSeconds: Math.round(config.soakMinutes * 60),
    startedAt: now,
    phaseStartedAt: now,
    phaseEndsAt: now + onSeconds * 1000,
    wateredSeconds: 0,
    attempts: 0,
  };
}

/** What the controller must do when the current phase ends, and the state once it has done it. */
export type Step =
  | { next: RunState; valve: "close" | "open" | "none"; finished: false }
  | { next: RunState; valve: "close"; finished: true };

export function advance(state: RunState, now: number): Step {
  const watered = state.wateredSeconds + (state.phase === "watering" ? state.onSeconds : 0);
  if (state.phase === "watering") {
    if (state.cycle >= state.cycles) {
      return { next: { ...idleState, trigger: state.trigger, startedAt: state.startedAt, wateredSeconds: watered }, valve: "close", finished: true };
    }
    if (state.soakSeconds === 0) {
      // no soak: stay open and roll straight into the next watering period
      return { next: { ...state, cycle: state.cycle + 1, phaseStartedAt: now, phaseEndsAt: now + state.onSeconds * 1000, wateredSeconds: watered, attempts: 0 }, valve: "open", finished: false };
    }
    return { next: { ...state, phase: "soaking", phaseStartedAt: now, phaseEndsAt: now + state.soakSeconds * 1000, wateredSeconds: watered, attempts: 0 }, valve: "close", finished: false };
  }
  return { next: { ...state, phase: "watering", cycle: state.cycle + 1, phaseStartedAt: now, phaseEndsAt: now + state.onSeconds * 1000, attempts: 0 }, valve: "open", finished: false };
}

/** Seconds of water delivered so far, including the phase in progress. */
export function wateredSoFar(state: RunState, now: number): number {
  if (state.phase !== "watering") return state.wateredSeconds;
  return state.wateredSeconds + Math.min(state.onSeconds, Math.max(0, Math.round((now - state.phaseStartedAt) / 1000)));
}

function localParts(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** Returns a unique key like "2026-10-21 06:00" if a schedule entry is due this minute. */
export function dueSchedule(config: Config, now: number, timeZone: string): string | null {
  if (!config.enabled) return null;
  const { day, date, time } = localParts(now, timeZone);
  const hit = config.schedules.some((s) => s.time === time && s.days.includes(day));
  return hit ? `${date} ${time}` : null;
}

function tzOffsetMs(ts: number, timeZone: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ts));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(ts / 1000) * 1000;
}

function localToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number {
  const guess = Date.UTC(y, m, d, hh, mm);
  const off = tzOffsetMs(guess, timeZone);
  let utc = guess - off;
  const off2 = tzOffsetMs(utc, timeZone); // the offset can differ across a DST change
  if (off2 !== off) utc = guess - off2;
  return utc;
}

/** The next scheduled start after `now` (epoch ms), or null when nothing is scheduled. */
export function nextRunAt(config: Config, now: number, timeZone: string): number | null {
  if (!config.enabled || config.schedules.length === 0) return null;
  const [y, m, d] = localParts(now, timeZone).date.split("-").map(Number);
  let best: number | null = null;
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    for (const s of config.schedules) {
      if (!s.days.includes(day.getUTCDay())) continue;
      const [hh, mm] = s.time.split(":").map(Number);
      const t = localToUtc(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh, mm, timeZone);
      if (t > now && (best === null || t < best)) best = t;
    }
  }
  return best;
}

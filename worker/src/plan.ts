// Pure scheduling logic. No I/O, so it is easy to test.

import { sunTimes } from "./sun";

export interface ScheduleEntry {
  days: number[]; // 0 = Sunday ... 6 = Saturday
  at?: "clock" | "dawn" | "dusk"; // missing means clock, so configs saved before sun-relative starts existed still work
  time: string; // "HH:MM" in the configured timezone (ignored for dawn and dusk)
  beforeSunriseMin?: number; // for dawn: how long before sunrise to start
  afterSunsetMin?: number; // for dusk: minutes after sunset to start, negative for before
  onlyIfEtMm?: number; // an extra run: only starts when the day's evapotranspiration is at least this (mm)
}

export interface RainConfig {
  enabled: boolean;
  probabilityPct: number; // skip if any hour in the window is at or above this
  mm: number; // skip if forecast total in the window is at or above this
  lookaheadHours: number;
  catchUp: boolean; // after a rain skip, check whether the rain came and water if it did not
}

/** Scales a scheduled run's number of cycles by the weather. Your on and soak minutes are never changed. */
export interface SmartConfig {
  enabled: boolean;
  referenceEtMm: number; // the day's ET (mm) at which your normal cycles apply
  cropFactor: number; // multiplies ET: roughly 1 for pots and beds, about 0.8 for lawn
  minPercent: number; // run only if the scaled amount is at least this percent of normal, else skip
  maxPercent: number; // never water more than this percent of normal
  soilDryBelow: number; // modelled soil moisture (m3/m3) at or below which the soil counts as dry
  soilWetAbove: number; // at or above which it counts as wet and the run is skipped
  wind: { enabled: boolean; maxKmh: number }; // skip when it is windier than this at the start
  frost: { enabled: boolean; belowC: number }; // skip when it is colder than this at the start
}

export interface Config {
  enabled: boolean;
  onMinutes: number;
  soakMinutes: number;
  cycles: number;
  schedules: ScheduleEntry[];
  rain: RainConfig;
  smart: SmartConfig;
}

export interface Place {
  timeZone: string;
  latitude: number;
  longitude: number;
}

export const defaultConfig: Config = {
  enabled: true,
  onMinutes: 10,
  soakMinutes: 5,
  cycles: 3,
  schedules: [
    { days: [0, 1, 2, 3, 4, 5, 6], at: "dawn", time: "00:00", beforeSunriseMin: 30 },
    { days: [0, 1, 2, 3, 4, 5, 6], at: "dusk", time: "00:00", afterSunsetMin: -30 },
  ],
  rain: { enabled: true, probabilityPct: 50, mm: 1, lookaheadHours: 6, catchUp: true },
  smart: {
    enabled: true,
    referenceEtMm: 4.5,
    cropFactor: 1,
    minPercent: 25,
    maxPercent: 150,
    soilDryBelow: 0.2,
    soilWetAbove: 0.4,
    wind: { enabled: true, maxKmh: 30 },
    frost: { enabled: true, belowC: 2 },
  },
};

/** Fill in anything a saved config predates, so adding a setting never breaks an existing install. */
export function normalizeConfig(stored: unknown): Config {
  const c = (stored ?? {}) as Partial<Config>;
  const d = defaultConfig;
  return {
    ...d,
    ...c,
    schedules: (c.schedules ?? d.schedules).map((s) => ({ at: "clock" as const, ...s })),
    rain: { ...d.rain, ...c.rain },
    smart: { ...d.smart, ...c.smart, wind: { ...d.smart.wind, ...c.smart?.wind }, frost: { ...d.smart.frost, ...c.smart?.frost } },
  };
}

export type Trigger = "schedule" | "catch-up" | "manual" | "google";

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
  const c = normalizeConfig(input);
  if (!input || typeof input !== "object") throw new Error("config must be an object");
  const num = (v: unknown, name: string, min: number, max: number) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      throw new Error(`${name} must be a number between ${min} and ${max}`);
    }
    return v;
  };
  const schedules = c.schedules;
  if (!Array.isArray(schedules) || schedules.length > 20) throw new Error("schedules must be a list of up to 20 entries");
  for (const s of schedules) {
    if (s.at !== "clock" && s.at !== "dawn" && s.at !== "dusk") throw new Error(`bad schedule type: ${s.at}`);
    if (s.at === "clock" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw new Error(`bad schedule time: ${s.time}`);
    if (s.at === "dawn") num(s.beforeSunriseMin, "schedule beforeSunriseMin", 0, 180);
    if (s.at === "dusk") num(s.afterSunsetMin, "schedule afterSunsetMin", -180, 180);
    if (s.onlyIfEtMm !== undefined) num(s.onlyIfEtMm, "schedule onlyIfEtMm", 0.5, 20);
    if (!Array.isArray(s.days) || s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new Error("schedule days must be integers 0-6");
    }
  }
  const r = c.rain;
  const m = c.smart;
  const smart: SmartConfig = {
    enabled: m.enabled !== false,
    referenceEtMm: num(m.referenceEtMm, "smart.referenceEtMm", 0.5, 15),
    cropFactor: num(m.cropFactor, "smart.cropFactor", 0.2, 2),
    minPercent: num(m.minPercent, "smart.minPercent", 0, 100),
    maxPercent: num(m.maxPercent, "smart.maxPercent", 50, 300),
    soilDryBelow: num(m.soilDryBelow, "smart.soilDryBelow", 0.05, 0.6),
    soilWetAbove: num(m.soilWetAbove, "smart.soilWetAbove", 0.05, 0.6),
    wind: { enabled: m.wind.enabled !== false, maxKmh: num(m.wind.maxKmh, "smart.wind.maxKmh", 5, 120) },
    frost: { enabled: m.frost.enabled !== false, belowC: num(m.frost.belowC, "smart.frost.belowC", -10, 10) },
  };
  if (smart.soilWetAbove <= smart.soilDryBelow) throw new Error("smart.soilWetAbove must be higher than smart.soilDryBelow");
  if (smart.maxPercent < smart.minPercent) throw new Error("smart.maxPercent must not be below smart.minPercent");
  return {
    enabled: c.enabled !== false,
    onMinutes: num(c.onMinutes, "onMinutes", 0.1, 60),
    soakMinutes: num(c.soakMinutes, "soakMinutes", 0, 240),
    cycles: num(c.cycles, "cycles", 1, 20),
    schedules: schedules.map((s) => ({ days: [...new Set(s.days)].sort(), at: s.at, time: s.at === "clock" ? s.time : "00:00", ...(s.at === "dawn" ? { beforeSunriseMin: s.beforeSunriseMin } : {}), ...(s.at === "dusk" ? { afterSunsetMin: s.afterSunsetMin } : {}), ...(s.onlyIfEtMm !== undefined ? { onlyIfEtMm: s.onlyIfEtMm } : {}) })),
    rain: {
      enabled: r.enabled !== false,
      probabilityPct: num(r.probabilityPct, "rain.probabilityPct", 0, 100),
      mm: num(r.mm, "rain.mm", 0, 100),
      lookaheadHours: num(r.lookaheadHours, "rain.lookaheadHours", 1, 48),
      catchUp: r.catchUp !== false,
    },
    smart,
  };
}

export function startRun(config: Config, trigger: Trigger, now: number, cycles: number = config.cycles): RunState {
  const onSeconds = Math.round(config.onMinutes * 60);
  return {
    phase: "watering",
    trigger,
    cycle: 1,
    cycles,
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

function tzOffsetMs(ts: number, timeZone: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ts));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(ts / 1000) * 1000;
}

export function localToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number {
  const guess = Date.UTC(y, m, d, hh, mm);
  const off = tzOffsetMs(guess, timeZone);
  let utc = guess - off;
  const off2 = tzOffsetMs(utc, timeZone); // the offset can differ across a DST change
  if (off2 !== off) utc = guess - off2;
  return utc;
}

/** When one schedule entry starts on a local calendar date, or null if it cannot (no sunrise that day). */
export function entryStart(entry: ScheduleEntry, y: number, m: number, d: number, place: Place): number | null {
  if (entry.at !== "dawn" && entry.at !== "dusk") {
    const [hh, mm] = entry.time.split(":").map(Number);
    return localToUtc(y, m - 1, d, hh, mm, place.timeZone);
  }
  const sun = sunTimes(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, place.latitude, place.longitude);
  if (!sun) return null;
  const t = entry.at === "dawn" ? sun.sunrise - (entry.beforeSunriseMin ?? 0) * 60_000 : sun.sunset + (entry.afterSunsetMin ?? 0) * 60_000;
  return Math.floor(t / 60_000) * 60_000;
}

/** The schedule entry that is due this minute, with a unique key like "2026-10-21 06:00", or null. */
export function dueEntry(config: Config, now: number, place: Place): { key: string; entry: ScheduleEntry } | null {
  if (!config.enabled) return null;
  const { day, date } = localParts(now, place.timeZone);
  const [y, m, d] = date.split("-").map(Number);
  for (const s of config.schedules) {
    if (!s.days.includes(day)) continue;
    const start = entryStart(s, y, m, d, place);
    if (start !== null && Math.floor(start / 60_000) === Math.floor(now / 60_000)) return { key: `${date} ${localParts(start, place.timeZone).time}`, entry: s };
  }
  return null;
}

/** Returns a unique key like "2026-10-21 06:00" if a schedule entry is due this minute. */
export function dueSchedule(config: Config, now: number, place: Place): string | null {
  return dueEntry(config, now, place)?.key ?? null;
}

/** The next scheduled start after `now` (epoch ms), or null when nothing is scheduled. */
export function nextRunAt(config: Config, now: number, place: Place): number | null {
  if (!config.enabled || config.schedules.length === 0) return null;
  const [y, m, d] = localParts(now, place.timeZone).date.split("-").map(Number);
  let best: number | null = null;
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    for (const s of config.schedules) {
      if (!s.days.includes(day.getUTCDay())) continue;
      const t = entryStart(s, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), place);
      if (t !== null && t > now && (best === null || t < best)) best = t;
    }
  }
  return best;
}

/** Every scheduled start on a local calendar date "YYYY-MM-DD" with the entry behind it, earliest first. */
export function scheduledEntriesOn(config: Config, date: string, place: Place): { at: number; entry: ScheduleEntry }[] {
  if (!config.enabled) return [];
  const [y, m, d] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return config.schedules
    .filter((s) => s.days.includes(weekday))
    .map((entry) => ({ at: entryStart(entry, y, m, d, place), entry }))
    .filter((r): r is { at: number; entry: ScheduleEntry } => r.at !== null)
    .sort((a, b) => a.at - b.at);
}

/** Every scheduled start (epoch ms) on a local calendar date "YYYY-MM-DD", earliest first. */
export function scheduledRunsOn(config: Config, date: string, place: Place): number[] {
  return scheduledEntriesOn(config, date, place).map((r) => r.at);
}

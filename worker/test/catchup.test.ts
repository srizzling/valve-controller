import { describe, expect, it } from "vitest";
import { catchUpStep, newCatchUp } from "../src/catchup";
import { defaultConfig } from "../src/plan";
import type { Forecast } from "../src/rain";

const HOUR = 3_600_000;
const place = { timeZone: "Australia/Melbourne", latitude: -37.72, longitude: 145 }; // UTC+11 in October
const rain = { ...defaultConfig.rain, lookaheadHours: 6 };

// Wed 2026-10-21 06:00 local is the run that was skipped; the next one is at 18:30 local
const skippedAt = Date.UTC(2026, 9, 20, 19, 0);
const nextRun = Date.UTC(2026, 9, 21, 7, 30);
const pending = newCatchUp(skippedAt, rain, nextRun)!;
const local = (h: number) => skippedAt + (h - 6) * HOUR; // epoch for an hour of that local day

/** Hourly from the skipped run to the end of the day. `mm` is rain per hour by local hour, `chance` the chance for every hour. */
function forecast(mm: Record<number, number> = {}, chance = 0): Forecast {
  const hours = Array.from({ length: 30 }, (_, i) => i);
  return {
    time: hours.map((h) => new Date(skippedAt + h * HOUR).toISOString().slice(0, 16)),
    precipitation_probability: hours.map(() => chance),
    precipitation: hours.map((h) => mm[h + 6] ?? 0),
  };
}

describe("newCatchUp", () => {
  it("checks one hour after the look-ahead and gives up before the next run", () => {
    expect(pending).toEqual({ skippedAt, checkAt: local(13), expiresAt: local(18) });
  });
  it("gives up after a day when nothing else is scheduled", () => {
    expect(newCatchUp(skippedAt, rain, null)?.expiresAt).toBe(skippedAt + 24 * HOUR);
  });
  it("makes no plan when the next run comes first", () => {
    expect(newCatchUp(skippedAt, rain, local(12))).toBeNull();
    expect(newCatchUp(skippedAt, rain, local(13.25))).toBeNull(); // too close once the buffer is taken off
  });
});

describe("catchUpStep", () => {
  const step = (f: Forecast | undefined, at: number, cfg = rain) => catchUpStep(pending, f, cfg, place, at);

  it("waits until the look-ahead has passed", () => expect(step(forecast(), local(12)).do).toBe("wait"));
  it("waters when the rain did not come", () => {
    const s = step(forecast({ 10: 0.2 }), local(14));
    expect(s).toMatchObject({ do: "run" });
    expect(s.do === "run" && s.note).toContain("0.2 mm");
  });
  it("drops it when enough rain fell", () => expect(step(forecast({ 9: 0.6, 10: 0.6 }), local(14)).do).toBe("drop"));
  it("ignores rain from before the skipped run", () => {
    const f = forecast();
    f.time.unshift(new Date(skippedAt - HOUR).toISOString().slice(0, 16));
    f.precipitation_probability.unshift(0);
    f.precipitation.unshift(5);
    expect(step(f, local(14)).do).toBe("run");
  });
  it("keeps waiting while more rain is forecast", () => expect(step(forecast({}, 80), local(14)).do).toBe("wait"));
  it("waits when the forecast cannot be fetched", () => expect(step(undefined, local(14)).do).toBe("wait"));
  it("waits for daylight", () => {
    const long = { ...pending, expiresAt: local(40) }; // as if nothing else were scheduled
    expect(catchUpStep(long, forecast(), rain, place, local(22)).do).toBe("wait"); // 22:00 is after sunset
    expect(catchUpStep(long, forecast(), rain, place, local(29)).do).toBe("wait"); // 05:00 next day is before sunrise
    expect(catchUpStep(long, forecast(), rain, place, local(31)).do).toBe("run"); // 07:00 next day
  });
  it("gives up at the deadline", () => expect(step(forecast(), local(18)).do).toBe("drop"));
  it("does nothing when switched off", () => {
    expect(step(forecast(), local(14), { ...rain, catchUp: false }).do).toBe("drop");
    expect(step(forecast(), local(14), { ...rain, enabled: false }).do).toBe("drop");
  });
  it("uses 1 mm as the bar when the mm limit is off", () => {
    expect(step(forecast({ 10: 0.6 }), local(14), { ...rain, mm: 0 }).do).toBe("run");
    expect(step(forecast({ 10: 1.2 }), local(14), { ...rain, mm: 0 }).do).toBe("drop");
  });
});

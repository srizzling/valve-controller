import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/plan";
import type { SmartConfig } from "../src/plan";
import type { Forecast } from "../src/rain";
import { inputsAt, smartPlan } from "../src/smart";

const cfg = (over: Partial<SmartConfig> = {}): SmartConfig => ({ ...defaultConfig.smart, ...over });

describe("smartPlan scaling", () => {
  it("runs the normal cycles on a typical day with dry soil", () => {
    expect(smartPlan(cfg(), 3, { etMm: 4.5, soilMoisture: 0.15 })).toMatchObject({ run: true, cycles: 3, percent: 100 });
  });

  it("adds a cycle on a hot dry day, and says why", () => {
    const p = smartPlan(cfg(), 3, { etMm: 6.2, soilMoisture: 0.14 }); // this week's hot dry Fri
    expect(p).toMatchObject({ run: true, cycles: 4, percent: 138 });
    expect(p.reasons[0]).toMatch(/hot, dry day.*ET 6.2 mm.*soil dry.*138%.*4 cycles instead of 3/i);
  });

  it("never goes above the cap", () => {
    expect(smartPlan(cfg(), 4, { etMm: 12, soilMoisture: 0.1 })).toMatchObject({ percent: 150, cycles: 6 });
    expect(smartPlan(cfg({ maxPercent: 120 }), 5, { etMm: 12, soilMoisture: 0.1 })).toMatchObject({ percent: 120, cycles: 6 });
  });

  it("does less on a mild day but still runs at least one cycle", () => {
    expect(smartPlan(cfg(), 3, { etMm: 2.0, soilMoisture: 0.16 })).toMatchObject({ run: true, cycles: 1, percent: 44 });
  });

  it("skips when the demand is below the minimum", () => {
    const p = smartPlan(cfg(), 3, { etMm: 1.0, soilMoisture: 0.16 }); // 22%, below the 25% minimum
    expect(p.run).toBe(false);
    expect(p.reasons[0]).toMatch(/low demand.*22%.*25% minimum/i);
  });

  it("skips when the soil is wet, however hot it is", () => {
    const p = smartPlan(cfg(), 3, { etMm: 6.2, soilMoisture: 0.4 });
    expect(p.run).toBe(false);
    expect(p.reasons[0]).toMatch(/soil is wet/i);
  });

  it("eases off as the soil dries from wet to dry", () => {
    // halfway between 0.20 (dry) and 0.35 (wet): half the demand
    expect(smartPlan(cfg(), 4, { etMm: 4.5, soilMoisture: 0.275 })).toMatchObject({ percent: 50, cycles: 2 });
  });

  it("scales ET by the crop factor", () => {
    expect(smartPlan(cfg({ cropFactor: 0.8 }), 3, { etMm: 4.5, soilMoisture: 0.15 })).toMatchObject({ percent: 80, cycles: 2 });
  });

  it("falls back to the normal cycles without ET data, and without soil data", () => {
    const noEt = smartPlan(cfg(), 3, {});
    expect(noEt).toMatchObject({ run: true, cycles: 3 });
    expect(noEt.reasons[0]).toMatch(/no evapotranspiration/i);
    expect(smartPlan(cfg(), 3, { etMm: 4.5 })).toMatchObject({ run: true, cycles: 3, percent: 100 });
  });
});

describe("smartPlan gates", () => {
  it("skips for frost and wind", () => {
    expect(smartPlan(cfg(), 3, { etMm: 5, tempMinC: 1 }).reasons[0]).toMatch(/frost risk.*1°C/i);
    expect(smartPlan(cfg(), 3, { etMm: 5, windKmh: 40 }).reasons[0]).toMatch(/too windy.*40 km\/h.*30/i);
    expect(smartPlan(cfg(), 3, { etMm: 5, tempMinC: 1 }).run).toBe(false);
  });

  it("still applies the gates when scaling is off, and runs the normal cycles otherwise", () => {
    expect(smartPlan(cfg({ enabled: false }), 3, { etMm: 9, windKmh: 50 }).run).toBe(false);
    expect(smartPlan(cfg({ enabled: false }), 3, { etMm: 9, windKmh: 10 })).toMatchObject({ run: true, cycles: 3, percent: 100 });
  });

  it("lets you turn a gate off, and respects the limits you set", () => {
    expect(smartPlan(cfg({ frost: { enabled: false, belowC: 2 } }), 3, { etMm: 4.5, tempMinC: -3 }).run).toBe(true);
    expect(smartPlan(cfg({ wind: { enabled: true, maxKmh: 60 } }), 3, { etMm: 4.5, windKmh: 40 }).run).toBe(true);
    expect(smartPlan(cfg({ frost: { enabled: true, belowC: -1 } }), 3, { etMm: 4.5, tempMinC: 0 }).run).toBe(true);
  });
});

describe("inputsAt", () => {
  // hourly series starting 2026-10-20T20:00 UTC, which is 07:00 on the 21st in Melbourne (UTC+11)
  const start = Date.UTC(2026, 9, 20, 20, 0);
  const hours = Array.from({ length: 10 }, (_, i) => new Date(start + i * 3_600_000).toISOString().slice(0, 16));
  const forecast: Forecast = {
    time: hours,
    precipitation_probability: hours.map(() => 0),
    precipitation: hours.map(() => 0),
    temperatureC: [9, 8, 7, 6, 12, 15, 18, 20, 21, 22],
    windKmh: [5, 8, 12, 34, 10, 6, 6, 6, 6, 6],
    soilMoistureShallow: [0.1, 0.12, 0.14, 0.16, 0.18, 0.2, 0.2, 0.2, 0.2, 0.2],
    soilMoistureDeep: [0.2, 0.22, 0.24, 0.26, 0.28, 0.3, 0.3, 0.3, 0.3, 0.3],
    etByDate: { "2026-10-21": 5.8, "2026-10-20": 4.1 },
  };

  it("reads ET for the local date, soil at the start, and temperature and wind in the next few hours", () => {
    const at = Date.UTC(2026, 9, 20, 22, 0); // 09:00 local on the 21st
    const i = inputsAt(forecast, at, "Australia/Melbourne");
    expect(i.etMm).toBe(5.8); // the 21st locally, although it is still the 20th in UTC
    expect(i.soilMoisture).toBeCloseTo((0.14 + 0.24) / 2, 5); // the hour of the start
    expect(i.tempMinC).toBe(6); // coldest of the hour before the start through three after
    expect(i.windKmh).toBe(34); // windiest of the same window
  });

  it("copes with series that are missing", () => {
    const bare: Forecast = { time: hours, precipitation_probability: [], precipitation: [] };
    expect(inputsAt(bare, start, "Australia/Melbourne")).toEqual({ etMm: undefined, soilMoisture: undefined, tempMinC: undefined, windKmh: undefined });
  });
});

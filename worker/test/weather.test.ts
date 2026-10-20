import { describe, expect, it } from "vitest";
import { defaultConfig, nextRunAt } from "../src/plan";
import { describeWeather, summarizeWeather } from "../src/weather";

describe("nextRunAt", () => {
  const cfg = { ...defaultConfig, schedules: [{ days: [3, 4], time: "06:00" }] }; // Wed and Thu
  const tz = "Australia/Melbourne"; // UTC+11 in October
  it("finds later today", () => {
    const now = Date.UTC(2026, 9, 20, 18, 0); // Wed 2026-10-21 05:00 local
    expect(nextRunAt(cfg, now, tz)).toBe(Date.UTC(2026, 9, 20, 19, 0));
  });
  it("rolls to the next matching day", () => {
    const now = Date.UTC(2026, 9, 21, 2, 0); // Wed 13:00 local
    expect(nextRunAt(cfg, now, tz)).toBe(Date.UTC(2026, 9, 21, 19, 0)); // Thu 06:00 local
  });
  it("wraps around the week", () => {
    const now = Date.UTC(2026, 9, 22, 20, 0); // Fri 07:00 local
    expect(nextRunAt(cfg, now, tz)).toBe(Date.UTC(2026, 9, 27, 19, 0)); // next Wed 06:00 local
  });
  it("is null when disabled or empty", () => {
    expect(nextRunAt({ ...cfg, enabled: false }, 0, tz)).toBeNull();
    expect(nextRunAt({ ...cfg, schedules: [] }, 0, tz)).toBeNull();
  });
});

describe("weather", () => {
  it("maps codes to conditions", () => {
    expect(describeWeather(0, true).kind).toBe("clear");
    expect(describeWeather(61).kind).toBe("rain");
    expect(describeWeather(95).kind).toBe("storm");
    expect(describeWeather(3).kind).toBe("cloudy");
  });

  it("summarises past and next 24h in the right hours, with local-time input", () => {
    // Local UTC+11. "now" is 2026-10-21 12:00 local = 01:00 UTC.
    const now = Date.UTC(2026, 9, 21, 1, 0);
    const times: string[] = [];
    for (let h = 0; h < 72; h++) times.push(new Date(Date.UTC(2026, 9, 20, 0, 0) + h * 3_600_000).toISOString().slice(0, 16)); // local wall-clock hours from 10-20 00:00
    const precipitation = times.map((t) => (t === "2026-10-21T08:00" ? 2 : t === "2026-10-21T14:00" ? 3 : 0)); // 08:00 local = past, 14:00 local = future
    const probability = times.map((t) => (t === "2026-10-21T14:00" ? 70 : 10));
    const raw = {
      utc_offset_seconds: 39600,
      current: { time: "2026-10-21T12:00", temperature_2m: 18.44, apparent_temperature: 16, relative_humidity_2m: 60.2, precipitation: 0, weather_code: 1, cloud_cover: 20, wind_speed_10m: 12.4, is_day: 1 },
      hourly: { time: times, precipitation, precipitation_probability: probability },
      daily: {
        time: ["2026-10-20", "2026-10-21", "2026-10-22"], weather_code: [3, 1, 61], temperature_2m_max: [20, 22, 19], temperature_2m_min: [10, 11, 12],
        precipitation_sum: [0, 0.4, 5.25], precipitation_probability_max: [10, 20, 80],
      },
    };
    const { data, forecast } = summarizeWeather(raw, now);
    expect(data.past24hMm).toBe(2);
    expect(data.next24hMm).toBe(3);
    expect(data.rainChanceNext24hPct).toBe(70);
    expect(data.current).toMatchObject({ temperatureC: 18.4, humidityPct: 60, isRaining: false, isDay: true });
    expect(data.daily.map((d) => d.date)).toEqual(["2026-10-21", "2026-10-22"]); // starts at today, not yesterday
    expect(data.daily[1]).toMatchObject({ rainMm: 5.3, chancePct: 80 });
    // forecast is re-expressed in UTC: 14:00 local on the 21st is 03:00 UTC
    const i = forecast.precipitation.indexOf(3);
    expect(forecast.time[i]).toBe("2026-10-21T03:00");
  });

  it("treats current rain as raining even with a clear-ish code", () => {
    const base = { utc_offset_seconds: 0, hourly: { time: ["2026-10-21T00:00"], precipitation: [0], precipitation_probability: [0] }, daily: { time: ["2026-10-21"], weather_code: [1], temperature_2m_max: [1], temperature_2m_min: [1], precipitation_sum: [0], precipitation_probability_max: [0] } };
    const mk = (precipitation: number) => ({ ...base, current: { time: "2026-10-21T00:00", temperature_2m: 1, apparent_temperature: 1, relative_humidity_2m: 1, precipitation, weather_code: 1, cloud_cover: 1, wind_speed_10m: 1, is_day: 1 } });
    expect(summarizeWeather(mk(0.5), 0).data.current.isRaining).toBe(true);
    expect(summarizeWeather(mk(0), 0).data.current.isRaining).toBe(false);
  });
});

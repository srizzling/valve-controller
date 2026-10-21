import { describe, expect, it } from "vitest";
import { localToUtc } from "../src/plan";
import { sunTimes } from "../src/sun";

// Reference times from Open-Meteo's archive (local time, minute precision). For the two winter dates the archive
// answered in today's daylight-saving offset rather than the offset in force on that date, one hour late, so those two
// are listed in the real local time (Melbourne is on AEST and London on GMT then).
const CASES = [
  { name: "Melbourne spring", lat: -37.72, lon: 145.0, tz: "Australia/Melbourne", date: "2025-10-21", rise: "06:27", set: "19:43" },
  { name: "Melbourne summer", lat: -37.72, lon: 145.0, tz: "Australia/Melbourne", date: "2025-12-21", rise: "05:54", set: "20:41" },
  { name: "Melbourne winter", lat: -37.72, lon: 145.0, tz: "Australia/Melbourne", date: "2025-06-21", rise: "07:35", set: "17:08" },
  { name: "London midsummer", lat: 51.5, lon: -0.12, tz: "Europe/London", date: "2025-06-21", rise: "04:43", set: "21:21" },
  { name: "London midwinter", lat: 51.5, lon: -0.12, tz: "Europe/London", date: "2025-12-21", rise: "08:03", set: "15:53" },
  { name: "New York equinox", lat: 40.71, lon: -74.0, tz: "America/New_York", date: "2025-03-20", rise: "06:58", set: "19:08" },
  { name: "Auckland summer", lat: -36.85, lon: 174.76, tz: "Pacific/Auckland", date: "2025-01-15", rise: "06:17", set: "20:41" },
];

const at = (date: string, hhmm: string, tz: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  return localToUtc(y, m - 1, d, hh, mm, tz);
};

describe("sunTimes", () => {
  for (const c of CASES) {
    it(`matches Open-Meteo within 3 minutes: ${c.name}`, () => {
      const t = sunTimes(c.date, c.lat, c.lon)!;
      expect(Math.abs(t.sunrise - at(c.date, c.rise, c.tz))).toBeLessThanOrEqual(3 * 60_000);
      expect(Math.abs(t.sunset - at(c.date, c.set, c.tz))).toBeLessThanOrEqual(3 * 60_000);
    });
  }

  it("has sunrise before sunset", () => {
    const t = sunTimes("2026-10-21", -37.72, 145.0)!;
    expect(t.sunrise).toBeLessThan(t.sunset);
  });

  it("returns null for the polar night and the midnight sun", () => {
    expect(sunTimes("2025-12-21", 78.2, 15.6)).toBeNull(); // Svalbard in winter
    expect(sunTimes("2025-06-21", 78.2, 15.6)).toBeNull(); // and in summer
  });
});

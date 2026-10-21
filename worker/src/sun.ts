// Sunrise and sunset from latitude, longitude and date alone (the standard "sunrise equation"), so a dawn schedule
// needs no network call. Good to a minute or two, which is plenty for starting a sprinkler.

const RAD = Math.PI / 180;
const mod = (a: number, b: number) => ((a % b) + b) % b;

export interface SunTimes {
  sunrise: number; // epoch ms
  sunset: number;
}

/** `date` is the civil date at the place ("YYYY-MM-DD"). Returns null where the sun does not rise or set that day. */
export function sunTimes(date: string, latitude: number, longitude: number): SunTimes | null {
  const [y, m, d] = date.split("-").map(Number);
  const julianDay = Date.UTC(y, m - 1, d, 12) / 86_400_000 + 2_440_587.5;
  const n = Math.round(julianDay - 2_451_545.0 + 0.0008);
  const jStar = n - longitude / 360; // east longitudes are positive
  const M = mod(357.5291 + 0.98560028 * jStar, 360);
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = mod(M + C + 180 + 102.9372, 360);
  const transit = 2_451_545.0 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const sinDelta = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD);
  const cosDelta = Math.cos(Math.asin(sinDelta));
  const cosOmega = (Math.sin(-0.833 * RAD) - Math.sin(latitude * RAD) * sinDelta) / (Math.cos(latitude * RAD) * cosDelta);
  if (cosOmega < -1 || cosOmega > 1) return null; // midnight sun or polar night
  const omega = Math.acos(cosOmega) / RAD;
  const toMs = (jd: number) => Math.round((jd - 2_440_587.5) * 86_400_000);
  return { sunrise: toMs(transit - omega / 360), sunset: toMs(transit + omega / 360) };
}

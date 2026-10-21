import type { Env } from "./env";
import type { Place } from "./plan";

export const placeOf = (env: Env): Place => ({ timeZone: env.TIMEZONE, latitude: Number(env.LATITUDE), longitude: Number(env.LONGITUDE) });

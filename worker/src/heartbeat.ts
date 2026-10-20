import type { Env } from "./env";

export type Signal = "start" | "ok" | "fail";

/** healthchecks.io ping URLs: base for success, base/start, base/fail. */
export const pingUrl = (base: string, signal: Signal) => {
  const root = base.replace(/\/+$/, "");
  return signal === "ok" ? root : `${root}/${signal}`;
};

/**
 * Dead-man's switch: healthchecks.io alerts when a scheduled run does not report in.
 * Best effort and optional, so a failure here never affects watering.
 */
export async function ping(env: Env, signal: Signal, body = ""): Promise<void> {
  if (!env.HEALTHCHECK_URL) return;
  try {
    const res = await fetch(pingUrl(env.HEALTHCHECK_URL, signal), { method: "POST", body: body.slice(0, 10_000), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.error(`healthchecks returned ${res.status}`);
  } catch (e) {
    console.error("healthchecks ping failed", e);
  }
}

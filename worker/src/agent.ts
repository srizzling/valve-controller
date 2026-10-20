import type { Env } from "./env";

async function call(env: Env, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${env.AGENT_URL}${path}`, {
    method: body === undefined && path === "/status" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${env.AGENT_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`agent ${path} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// The agent also closes the valve by itself after `seconds`, so the margin only
// matters if this Worker never gets to send the explicit close.
const FAILSAFE_MARGIN_SECONDS = 90;

export const openValve = (env: Env, seconds: number) => call(env, "/valve/open", { seconds: seconds + FAILSAFE_MARGIN_SECONDS });
export const closeValve = (env: Env) => call(env, "/valve/close", {});
export const valveStatus = (env: Env) => call(env, "/status");

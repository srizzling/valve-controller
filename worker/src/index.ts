import { Hono } from "hono";
import { checkAccess } from "./access";
import { Controller } from "./controller";
import type { Env } from "./env";
import { googleRoutes } from "./google";
import { validateConfig } from "./plan";
import { fetchForecast, rainVerdict } from "./rain";
import type { RainVerdict } from "./rain";
import { plannedRuns } from "./outlook";
import type { PlannedRun } from "./outlook";
import { placeOf } from "./place";
import { getWeather } from "./weather";

export { Controller };

const controller = (env: Env) => env.CONTROLLER.get(env.CONTROLLER.idFromName("main"));

const api = new Hono<{ Bindings: Env }>();
api.use("*", async (c, next) => {
  const access = await checkAccess(c.req.raw, c.env);
  if (!access.ok) return c.json({ error: access.error }, access.status);
  await next();
});
api.get("/status", async (c) => c.json(await controller(c.env).getStatus()));
api.put("/config", async (c) => {
  try {
    return c.json(await controller(c.env).setConfig(validateConfig(await c.req.json())));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "invalid config" }, 400);
  }
});
api.post("/start", async (c) => {
  const r = await controller(c.env).start("manual");
  return c.json(r, r.ok ? 200 : 409);
});
api.post("/stop", async (c) => c.json(await controller(c.env).stop()));
// Everything the weather panel needs, plus whether the next scheduled run would go ahead
api.get("/weather", async (c) => {
  const status = await controller(c.env).getStatus();
  try {
    const { data, forecast } = await getWeather(c.env);
    const now = Date.now();
    const daily = data.daily.map((d) => ({ ...d, runs: plannedRuns(status.config, d.date, forecast, status.history, now, placeOf(c.env)) }));
    const runs = daily.flatMap((d) => d.runs);
    // Extra runs that the forecast says are not needed are not in the outlook, so the next run is the first one that is.
    const upcoming = runs.filter((r) => r.at > now).sort((x, y) => x.at - y.at)[0];
    const nextAt = status.nextRunAt && upcoming && upcoming.at > status.nextRunAt ? upcoming.at : status.nextRunAt;
    let nextRun: { at: number; verdict: RainVerdict | null; note?: string; planned?: PlannedRun } | null = null;
    if (nextAt) {
      nextRun = { at: nextAt, verdict: null, planned: runs.find((r) => r.at === nextAt) };
      if (!status.config.rain.enabled) nextRun.verdict = { skip: false, reason: "rain check is off" };
      else {
        try {
          nextRun.verdict = rainVerdict(forecast, status.config.rain, nextAt);
        } catch (e) {
          nextRun.note = e instanceof Error ? e.message : "no forecast for that time";
        }
      }
    }
    return c.json({ ...data, daily, nextRun });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "weather unavailable" }, 502);
  }
});
// Diagnostics: what would the rain check say right now, and what does the valve itself report?
api.get("/rain", async (c) => {
  const { rain } = await controller(c.env).getConfig();
  try {
    return c.json(rainVerdict(await fetchForecast(c.env.LATITUDE, c.env.LONGITUDE), rain, Date.now()));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "forecast failed" }, 502);
  }
});
api.get("/valve", async (c) => {
  try {
    return c.json(await controller(c.env).getValve());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "valve unreachable" }, 502);
  }
});

const app = new Hono<{ Bindings: Env }>();
app.route("/api", api);
app.route("/", googleRoutes(controller));

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(controller(env).tick());
  },
} satisfies ExportedHandler<Env>;

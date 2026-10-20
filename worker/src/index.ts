import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { valveStatus } from "./agent";
import { Controller } from "./controller";
import type { Env } from "./env";
import { googleRoutes } from "./google";
import { validateConfig } from "./plan";
import { fetchForecast, rainVerdict } from "./rain";

export { Controller };

const controller = (env: Env) => env.CONTROLLER.get(env.CONTROLLER.idFromName("main"));

const api = new Hono<{ Bindings: Env }>();
api.use("*", (c, next) => bearerAuth<{ Bindings: Env }>({ token: c.env.API_TOKEN })(c, next));
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
    return c.json(await valveStatus(c.env));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "agent unreachable" }, 502);
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

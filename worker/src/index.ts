import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { checkAccess } from "./access";
import { isFrameKind } from "./camera";
import { Controller } from "./controller";
import type { Env } from "./env";
import { googleRoutes } from "./google";
import { validateConfig } from "./plan";
import { fetchForecast, rainVerdict } from "./rain";
import type { RainVerdict } from "./rain";
import { plannedRuns } from "./outlook";
import type { PlannedRun } from "./outlook";
import { placeOf } from "./place";
import { securityHeaders } from "./security";
import { qrSvg } from "./qr";
import type { Reconnect } from "./valve";

export { Controller };

const controller = (env: Env) => env.CONTROLLER.get(env.CONTROLLER.idFromName("main"));

const SERVICE_TOKEN_ROUTES = new Set(["GET /api/camera/wanted", "POST /api/camera/frame"]);

const api = new Hono<{ Bindings: Env }>();
// The Access cookie is sent with any request from the browser, so refuse writes that another site triggered.
api.use("*", csrf());
api.use("*", async (c, next) => {
  const access = await checkAccess(c.req.raw, c.env);
  if (!access.ok) return c.json({ error: access.error }, access.status);
  // The camera script signs in with an Access service token, which must not be able to do anything else (start the valve, say).
  if (access.serviceToken && !SERVICE_TOKEN_ROUTES.has(`${c.req.method} ${new URL(c.req.url).pathname}`)) return c.json({ error: "this token may only talk to the camera" }, 403);
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
  const stub = controller(c.env);
  const weatherP = stub.weather();
  weatherP.catch(() => undefined); // handled below; this keeps it from counting as unhandled while the status loads
  const status = await stub.getStatus();
  try {
    const { data, forecast } = await weatherP;
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
          // a run forced after a rain skip goes ahead whatever the forecast says
          if (nextRun.verdict.skip && nextRun.planned?.state === "will-run") nextRun.verdict = { skip: false, reason: nextRun.planned.reason };
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
    const valve = await controller(c.env).getValve();
    return c.json(valve, "error" in valve ? 502 : 200);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "valve unreachable" }, 502);
  }
});
// Sign the Worker back in to Tuya from the UI: POST shows a QR code to scan in the Smart Life app, GET polls for the scan.
const reconnectReply = (r: Reconnect) => ("payload" in r ? { state: r.state, svg: qrSvg(r.payload) } : r);
api.post("/tuya/login", async (c) => {
  try {
    return c.json(reconnectReply(await controller(c.env).reconnectStart()));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "could not start the login" }, 502);
  }
});
api.get("/tuya/login", async (c) => {
  try {
    return c.json(reconnectReply(await controller(c.env).reconnectCheck()));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "could not check the login" }, 502);
  }
});

// The garden camera. The script at home polls /wanted, then posts the frame it was asked for.
api.get("/camera", async (c) => c.json(await controller(c.env).cameraOverview()));
api.get("/camera/wanted", async (c) => c.json({ capture: await controller(c.env).cameraWanted() }));
api.post("/camera/snapshot", async (c) => {
  await controller(c.env).cameraRequest();
  return c.json({ ok: true, message: "Asked the camera for a photo" });
});
api.post("/camera/frame", async (c) => {
  const kind = c.req.query("kind");
  if (!isFrameKind(kind)) return c.json({ error: "kind must be during, after, manual or timelapse" }, 400);
  try {
    return c.json(await controller(c.env).cameraFrame(kind, await c.req.arrayBuffer()));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "could not keep the frame" }, 400);
  }
});
// "latest", "leak" or a date. A day's photo never changes, so the browser may keep it.
api.get("/camera/image/:which", async (c) => {
  const which = c.req.param("which");
  const image = await controller(c.env).cameraImage(which);
  if (!image) return c.json({ error: "no such photo" }, 404);
  return c.body(image, 200, { "Content-Type": "image/jpeg", "Cache-Control": /^\d/.test(which) ? "private, max-age=31536000, immutable" : "no-store" });
});

const app = new Hono<{ Bindings: Env }>();
app.use("*", securityHeaders);
app.route("/api", api);
app.route("/", googleRoutes(controller));

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(controller(env).tick());
  },
} satisfies ExportedHandler<Env>;

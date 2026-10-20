// Google Home "Smart Home Action" (cloud-to-cloud): account linking + fulfillment.
import { Hono } from "hono";
import type { Controller } from "./controller";
import type { Env } from "./env";

type App = { Bindings: Env };

const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const hmacKey = (secret: string) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function signToken(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64u(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)))}`;
}

export async function verifyToken(secret: string, token: string, typ: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64u(sig), enc.encode(body)))) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64u(body))) as { typ: string; exp?: number; redirect_uri?: string };
    if (payload.typ !== typ || (payload.exp !== undefined && payload.exp < nowSeconds)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  return crypto.subtle.timingSafeEqual(da, db);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const allowedRedirect = (env: Env, uri: string) =>
  !!env.GOOGLE_PROJECT_ID &&
  [`https://oauth-redirect.googleusercontent.com/r/${env.GOOGLE_PROJECT_ID}`, `https://oauth-redirect-sandbox.googleusercontent.com/r/${env.GOOGLE_PROJECT_ID}`].includes(uri);

const DEVICE_ID = "valve";
const ACCESS_TTL = 3600;

export function googleRoutes(controller: (env: Env) => DurableObjectStub<Controller>) {
  const app = new Hono<App>();

  const authorizeForm = (p: URLSearchParams, error = "") => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Link valve controller</title><body style="font-family:system-ui;max-width:24rem;margin:3rem auto;padding:0 1rem">
<h1>Link valve controller</h1>${error ? `<p style="color:#b00">${escapeHtml(error)}</p>` : ""}
<form method=post>${["client_id", "redirect_uri", "state", "response_type"].map((k) => `<input type=hidden name=${k} value="${escapeHtml(p.get(k) ?? "")}">`).join("")}
<label>Access token<br><input name=password type=password autofocus style="width:100%;padding:.5rem"></label>
<p><button style="padding:.5rem 1rem">Link</button></p></form>`;

  const checkAuthorizeParams = (env: Env, p: URLSearchParams) =>
    !!env.GOOGLE_CLIENT_ID && p.get("client_id") === env.GOOGLE_CLIENT_ID && p.get("response_type") === "code" && allowedRedirect(env, p.get("redirect_uri") ?? "");

  app.get("/oauth/authorize", (c) => {
    const p = new URL(c.req.url).searchParams;
    if (!checkAuthorizeParams(c.env, p)) return c.text("invalid request", 400);
    return c.html(authorizeForm(p));
  });

  app.post("/oauth/authorize", async (c) => {
    const form = await c.req.formData();
    const p = new URLSearchParams(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
    if (!checkAuthorizeParams(c.env, p)) return c.text("invalid request", 400);
    if (!(await safeEqual(p.get("password") ?? "", c.env.API_TOKEN))) return c.html(authorizeForm(p, "Wrong token"), 401);
    const redirect = p.get("redirect_uri")!;
    const code = await signToken(c.env.SIGNING_KEY, { typ: "code", exp: Math.floor(Date.now() / 1000) + 600, redirect_uri: redirect });
    const url = new URL(redirect);
    url.searchParams.set("code", code);
    url.searchParams.set("state", p.get("state") ?? "");
    return c.redirect(url.toString(), 302);
  });

  app.post("/oauth/token", async (c) => {
    const form = await c.req.formData();
    const get = (k: string) => String(form.get(k) ?? "");
    let clientId = get("client_id");
    let clientSecret = get("client_secret");
    const basic = c.req.header("authorization")?.match(/^Basic (.+)$/);
    if (basic) [clientId, clientSecret] = atob(basic[1]).split(/:(.*)/s);
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !(await safeEqual(clientId, c.env.GOOGLE_CLIENT_ID)) || !(await safeEqual(clientSecret, c.env.GOOGLE_CLIENT_SECRET))) {
      return c.json({ error: "invalid_client" }, 401);
    }
    const now = Math.floor(Date.now() / 1000);
    const access = () => signToken(c.env.SIGNING_KEY, { typ: "access", exp: now + ACCESS_TTL });
    if (get("grant_type") === "authorization_code") {
      const code = await verifyToken(c.env.SIGNING_KEY, get("code"), "code");
      if (!code || code.redirect_uri !== get("redirect_uri")) return c.json({ error: "invalid_grant" }, 400);
      return c.json({
        token_type: "bearer",
        access_token: await access(),
        refresh_token: await signToken(c.env.SIGNING_KEY, { typ: "refresh" }),
        expires_in: ACCESS_TTL,
      });
    }
    if (get("grant_type") === "refresh_token") {
      if (!(await verifyToken(c.env.SIGNING_KEY, get("refresh_token"), "refresh"))) return c.json({ error: "invalid_grant" }, 400);
      return c.json({ token_type: "bearer", access_token: await access(), expires_in: ACCESS_TTL });
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  app.post("/google/fulfillment", async (c) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!(await verifyToken(c.env.SIGNING_KEY, token, "access"))) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{ requestId: string; inputs: { intent: string; payload?: any }[] }>();
    const { intent, payload } = body.inputs[0];
    const ctrl = controller(c.env);
    const running = async () => (await ctrl.getStatus()).state.phase !== "idle";

    switch (intent) {
      case "action.devices.SYNC":
        return c.json({
          requestId: body.requestId,
          payload: {
            agentUserId: "owner",
            devices: [{
              id: DEVICE_ID,
              type: "action.devices.types.SPRINKLER",
              traits: ["action.devices.traits.OnOff", "action.devices.traits.StartStop"],
              name: { name: "Garden water" },
              willReportState: false,
              attributes: { pausable: false },
            }],
          },
        });
      case "action.devices.QUERY": {
        const on = await running();
        return c.json({ requestId: body.requestId, payload: { devices: { [DEVICE_ID]: { status: "SUCCESS", online: true, on, isRunning: on } } } });
      }
      case "action.devices.EXECUTE": {
        const commands = [];
        for (const cmd of payload.commands as { devices: { id: string }[]; execution: { command: string; params: { on?: boolean; start?: boolean } }[] }[]) {
          const ids = cmd.devices.map((d) => d.id);
          let status: "SUCCESS" | "ERROR" = "SUCCESS";
          let errorCode: string | undefined;
          for (const ex of cmd.execution) {
            const want = ex.command === "action.devices.commands.OnOff" ? ex.params.on : ex.command === "action.devices.commands.StartStop" ? ex.params.start : undefined;
            if (want === undefined) { status = "ERROR"; errorCode = "functionNotSupported"; continue; }
            const r = want ? await ctrl.start("google") : await ctrl.stop();
            if (!r.ok && r.message !== "already running") { status = "ERROR"; errorCode = "deviceOffline"; }
          }
          const on = await running();
          commands.push({ ids, status, ...(errorCode ? { errorCode } : {}), states: { online: true, on, isRunning: on } });
        }
        return c.json({ requestId: body.requestId, payload: { commands } });
      }
      case "action.devices.DISCONNECT":
        return c.json({});
      default:
        return c.json({ requestId: body.requestId, payload: { errorCode: "protocolError" } });
    }
  });

  return app;
}

import { describe, expect, it, vi } from "vitest";
import headers from "../assets-headers.txt?raw";
import html from "../public/index.html?raw";
import js from "../public/app.js?raw";
import css from "../public/style.css?raw";

// index.ts pulls in the Durable Object base class, which only exists inside the Workers runtime.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { default: worker } = await import("../src/index");

const env = {
  DEV_BYPASS_ACCESS: "true",
  GOOGLE_PROJECT_ID: "proj",
  GOOGLE_CLIENT_ID: "valve-controller",
  CONTROLLER: {
    idFromName: () => "id",
    get: () => ({ getStatus: async () => ({ ok: true }), stop: async () => ({ ok: true }) }),
  },
} as never;
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://valve.example${path}`, init), env, {} as never);

describe("security headers", () => {
  it("sends a deny-everything CSP, no framing and no sniffing on API responses", async () => {
    const res = await call("/api/status");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
  });

  it("also covers errors and the token endpoint", async () => {
    const res = await call("/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "x" }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("lets the linking page style itself and post only to itself or Google, with no script", async () => {
    const params = new URLSearchParams({ client_id: "valve-controller", response_type: "code", redirect_uri: "https://oauth-redirect.googleusercontent.com/r/proj", state: "s" });
    const res = await call(`/oauth/authorize?${params}`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("form-action 'self' https://oauth-redirect.googleusercontent.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src/);
    expect(await res.text()).not.toMatch(/<script/i);
  });
});

describe("cross-site writes to the API", () => {
  it("are refused", async () => {
    const attacks: (RequestInit & { method: string })[] = [
      { method: "POST", headers: { origin: "https://evil.example" } },
      { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: "{}" },
      { method: "PUT", headers: { "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" }, body: "a=b" },
    ];
    for (const init of attacks) {
      const res = await call(init.method === "PUT" ? "/api/config" : "/api/stop", init);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'"); // headers survive the error path
    }
  });

  it("are allowed from the app's own origin", async () => {
    const res = await call("/api/stop", { method: "POST", headers: { origin: "https://valve.example", "content-type": "application/json" } });
    expect(res.status).toBe(200);
  });
});

// The UI's CSP (index.html and worker/assets-headers.txt) forbids inline script and style, so keep the markup free of them.
describe("static UI works under its CSP", () => {
  const metaCsp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];

  it("has no inline script, style, handler or style attribute", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(js).not.toMatch(/\sstyle=["'`$]/); // markup built in JS
    expect(js).not.toMatch(/\bon[a-z]+=["'`]/);
    expect(js).not.toMatch(/\beval\(|new Function\(/);
  });

  it("loads nothing from other origins", () => {
    expect(css).not.toMatch(/@import|url\(\s*["']?(https?:)?\/\//i);
    expect(html.replace(/xmlns="[^"]*"/g, "")).not.toMatch(/(src|href)="(https?:)?\/\//);
  });

  it("repeats the same policy in the page and in the headers file, without the directives a <meta> cannot carry", () => {
    expect(metaCsp).toBeTruthy();
    expect(metaCsp).not.toMatch(/frame-ancestors/);
    const fileCsp = /Content-Security-Policy: (.+)/.exec(headers)![1];
    expect(fileCsp.replace(/; frame-ancestors 'none'/, "")).toBe(metaCsp);
  });
});

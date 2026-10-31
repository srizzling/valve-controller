import { afterEach, describe, expect, it, vi } from "vitest";
import { startRun, defaultConfig } from "../src/plan";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));
const { Controller } = await import("../src/controller");

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string | string[]) => (Array.isArray(k) ? new Map(k.map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k: string | Record<string, unknown>, v?: unknown) => void (typeof k === "string" ? m.set(k, v) : Object.entries(k).forEach(([a, b]) => m.set(a, b))),
    delete: async (k: string | string[]) => void [k].flat().forEach((x) => m.delete(x)),
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    m,
  };
}

const hostOf = (url: string) => new URL(url).host;
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer;
const baseEnv = { TIMEZONE: "Australia/Melbourne", LATITUDE: "-37.81", LONGITUDE: "144.96", NTFY_URL: "https://ntfy.test", NTFY_TOPIC: "t", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://claude.test" };

function make(verdict: object | null) {
  const storage = fakeStorage();
  const calls: { url: string; method?: string; headers: Headers }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method, headers: new Headers(init.headers) });
    if (hostOf(url) === "claude.test") return verdict ? Response.json({ content: [{ type: "tool_use", name: "report", input: verdict }] }) : new Response("busy", { status: 529 });
    return new Response("ok");
  });
  const c = new Controller({ storage } as never, baseEnv as never);
  return { c, storage, calls, ntfy: () => calls.filter((x) => hostOf(x.url) === "ntfy.test") };
}

afterEach(() => vi.unstubAllGlobals());

describe("Controller camera", () => {
  it("rejects a frame that is not a JPEG", async () => {
    const { c } = make({ leak: false, summary: "x" });
    await expect(c.cameraFrame("manual", new TextEncoder().encode("<html>nope</html>").buffer as ArrayBuffer)).rejects.toThrow(/JPEG/);
  });

  it("keeps a clean frame as the latest and stays quiet", async () => {
    const { c, ntfy } = make({ leak: false, summary: "Dry" });
    const meta = await c.cameraFrame("manual", jpeg);
    expect(meta.verdict).toEqual({ leak: false, summary: "Dry" });
    expect((await c.cameraOverview()).latest).toEqual(meta);
    expect(await c.cameraImage("latest")).toEqual(jpeg);
    expect(ntfy()).toHaveLength(0);
  });

  it("alerts once, with the photo, when a watering frame shows a leak", async () => {
    const { c, storage, ntfy } = make({ leak: true, summary: "Hose has split" });
    await storage.put("state", startRun(defaultConfig, "manual", Date.now() - 60_000));
    await c.cameraFrame("during", jpeg);
    await c.cameraFrame("during", jpeg); // the next cycle of the same run
    expect(ntfy()).toHaveLength(1);
    expect(ntfy()[0].method).toBe("PUT");
    expect(ntfy()[0].headers.get("message")).toContain("Hose has split");
    expect(ntfy()[0].headers.get("message")).toContain("Stop");
    expect((await c.cameraOverview()).leak?.verdict?.leak).toBe(true);
    expect(await c.cameraImage("leak")).toEqual(jpeg);
  });

  it("does not alert when the model is unavailable, and says why", async () => {
    const { c, ntfy } = make(null);
    const meta = await c.cameraFrame("after", jpeg);
    expect(meta.error).toMatch(/529/);
    expect(ntfy()).toHaveLength(0);
  });

  it("answers a request once: the daily frame is not asked for again, and is kept for the timelapse", async () => {
    const { c } = make({ leak: false, summary: "Dry", plant: "Tall and green" });
    await c.cameraFrame("timelapse", jpeg);
    const { days } = await c.cameraOverview();
    expect(days).toHaveLength(1);
    expect(days[0].plant).toBe("Tall and green");
    expect(await c.cameraImage(days[0].date)).toEqual(jpeg);
    expect(await c.cameraWanted()).not.toBe("timelapse");
    expect(await c.cameraImage("../etc")).toBeNull();
  });

  it("asks for a photo after the UI requests one, and stops once it arrives", async () => {
    const { c } = make({ leak: false, summary: "Dry" });
    await c.cameraFrame("timelapse", jpeg); // clear the daily frame so only the request is pending
    await c.cameraRequest();
    expect(await c.cameraWanted()).toBe("manual");
    await c.cameraFrame("manual", jpeg);
    expect(await c.cameraWanted()).toBeNull();
  });

  it("tells you once when a script that was running goes quiet, and again after it comes back and goes quiet", async () => {
    const { c, storage, ntfy } = make({ leak: false, summary: "Dry" });
    await c.cameraWanted(); // the script is seen
    await storage.put("cam:polled", Date.now() - 20 * 60_000);
    await (c as never as { watchCameraScript(n: number): Promise<void> }).watchCameraScript(Date.now());
    await (c as never as { watchCameraScript(n: number): Promise<void> }).watchCameraScript(Date.now());
    expect(ntfy()).toHaveLength(1);
    expect(ntfy()[0].headers.get("title")).toMatch(/camera script/i);
    await storage.put("cam:polled", Date.now());
    await (c as never as { watchCameraScript(n: number): Promise<void> }).watchCameraScript(Date.now());
    expect((await c.cameraOverview()).lastPollAt).not.toBeNull();
    await storage.put("cam:polled", Date.now() - 20 * 60_000);
    await (c as never as { watchCameraScript(n: number): Promise<void> }).watchCameraScript(Date.now());
    expect(ntfy()).toHaveLength(2);
  });

  it("says nothing about a camera script that was never set up", async () => {
    const { c, ntfy } = make({ leak: false, summary: "Dry" });
    await (c as never as { watchCameraScript(n: number): Promise<void> }).watchCameraScript(Date.now());
    expect(ntfy()).toHaveLength(0);
  });
});

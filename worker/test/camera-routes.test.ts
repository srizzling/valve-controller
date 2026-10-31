import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
let who: { ok: true; serviceToken?: string; email?: string } = { ok: true, serviceToken: "client-id" };
vi.mock("../src/access", () => ({ checkAccess: async () => who }));
const { default: worker } = await import("../src/index");

const stub = {
  cameraWanted: async () => "during",
  cameraFrame: async (kind: string, image: ArrayBuffer) => ({ at: 1, kind, bytes: image.byteLength }),
  cameraImage: async (which: string) => (which === "latest" || /^\d{4}-/.test(which) ? new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]).buffer : null),
  start: async () => ({ ok: true, message: "started" }),
  stop: async () => ({ ok: true, message: "stopped" }),
  getStatus: async () => ({}),
};
const env = { CONTROLLER: { idFromName: () => "id", get: () => stub } } as never;
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://valve.example${path}`, init), env, {} as never);
const origin = { origin: "https://valve.example" };

describe("the camera script's service token", () => {
  it("can ask what to capture and post a frame", async () => {
    who = { ok: true, serviceToken: "client-id" };
    expect(await (await call("/api/camera/wanted")).json()).toEqual({ capture: "during" });
    const res = await call("/api/camera/frame?kind=during", { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Uint8Array([0xff, 0xd8, 0xff, 1]) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "during", bytes: 4 });
  });

  it("cannot do anything else, such as open the valve or read the status", async () => {
    who = { ok: true, serviceToken: "client-id" };
    expect((await call("/api/start", { method: "POST", headers: origin })).status).toBe(403);
    expect((await call("/api/stop", { method: "POST", headers: origin })).status).toBe(403);
    expect((await call("/api/status")).status).toBe(403);
    expect((await call("/api/camera/image/latest")).status).toBe(403);
  });

  it("is not needed when a person is signed in", async () => {
    who = { ok: true, email: "me@example.com" };
    expect((await call("/api/stop", { method: "POST", headers: origin })).status).toBe(200);
  });
});

describe("camera routes", () => {
  it("refuse an unknown kind", async () => {
    who = { ok: true, email: "me@example.com" };
    expect((await call("/api/camera/frame?kind=nope", { method: "POST", headers: origin, body: "x" })).status).toBe(400);
  });

  it("serve photos as images, keeping a day's photo but never the latest", async () => {
    who = { ok: true, email: "me@example.com" };
    const latest = await call("/api/camera/image/latest");
    expect(latest.headers.get("content-type")).toBe("image/jpeg");
    expect(latest.headers.get("cache-control")).toBe("no-store");
    const day = await call("/api/camera/image/2026-11-02");
    expect(day.headers.get("cache-control")).toContain("immutable");
    expect((await call("/api/camera/image/leak")).status).toBe(404);
  });
});

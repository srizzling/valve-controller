import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { sessionFromSeed } from "../src/tuya";
import { Valve } from "../src/valve";
import { fakeServer, newState } from "./helpers/fakeTuya";

class FakeStorage {
  data = new Map<string, unknown>();
  async get<T>(k: string) { return this.data.get(k) as T | undefined; }
  async put(k: string, v: unknown) { this.data.set(k, v); }
  async delete(k: string) { return this.data.delete(k); }
}

const seedJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ client_id: "client", user_code: "u", terminal_id: "t", endpoint: "https://api.test", uid: "uid0", access_token: "tok", refresh_token: "ref", expire_time: 7200, t: 1_000_000, ...over });

const env = (over: Partial<Env> = {}) => ({ TUYA_DEVICE_ID: "dev1", TUYA_SESSION: seedJson(), ...over }) as Env;

/** A valve that accepts commands, then reports the new state, like the real one. */
function setup(opts: { envOver?: Partial<Env>; reportsCommands?: boolean; storage?: FakeStorage } = {}) {
  const device: Record<string, unknown> = { switch_1: false, countdown_1: 0, battery_percentage: 64 };
  const commands: { code: string; value: unknown }[][] = [];
  const st = newState({
    now: 1_000_000,
    handler: (path: string, q: any, body: any) => {
      if (path === "/v1.1/m/thing/dev1/commands") {
        commands.push(body.commands);
        if (opts.reportsCommands !== false) for (const c of body.commands) device[c.code] = c.value;
        return true;
      }
      if (path === "/v1.0/m/life/ha/devices/detail") return [{ online: true, status: Object.entries(device).map(([code, value]) => ({ code, value })) }];
      return null;
    },
  });
  const storage = opts.storage ?? new FakeStorage();
  const valve = new Valve(storage as unknown as DurableObjectStorage, env(opts.envOver), { fetch: fakeServer(st), now: () => st.now, sleep: async () => {} });
  return { valve, device, commands, st, storage };
}

describe("Valve", () => {
  it("opens with a valve-side countdown a little longer than the run, and confirms it", async () => {
    const { valve, commands, device } = setup();
    await valve.open(600);
    expect(commands).toEqual([[{ code: "switch_1", value: true }, { code: "countdown_1", value: 690 }]]);
    expect(device.switch_1).toBe(true);
  });

  it("closes and confirms", async () => {
    const { valve, commands, device } = setup();
    await valve.open(60);
    await valve.close();
    expect(commands[1]).toEqual([{ code: "switch_1", value: false }]);
    expect(device.switch_1).toBe(false);
  });

  it("fails loudly when the valve never reports the change", async () => {
    const { valve } = setup({ reportsCommands: false });
    await expect(valve.open(60)).rejects.toThrow(/did not report open/);
    await expect(valve.close()).resolves.toBeUndefined(); // it already reads closed
  });

  it("reads status including battery and countdown", async () => {
    const { valve, device } = setup();
    device.switch_1 = true;
    device.countdown_1 = 540;
    expect(await valve.status()).toEqual({ online: true, open: true, batteryPct: 64, countdownSeconds: 540 });
  });

  it("works without a countdown function when asked to", async () => {
    const { valve, commands } = setup({ envOver: { TUYA_COUNTDOWN_CODE: "" } });
    await valve.open(60);
    expect(commands[0]).toEqual([{ code: "switch_1", value: true }]);
  });

  it("uses configured data point codes", async () => {
    const { valve, commands, device } = setup({ envOver: { TUYA_SWITCH_CODE: "switch", TUYA_COUNTDOWN_CODE: "countdown" } });
    device.switch = false;
    await valve.open(30);
    expect(commands[0].map((c) => c.code)).toEqual(["switch", "countdown"]);
  });

  it("shares one client between requests that arrive together, so the token is refreshed once", async () => {
    const { valve, st } = setup({ envOver: { TUYA_SESSION: seedJson({ expire_time: 30 }) } });
    await Promise.all([valve.status(), valve.status(), valve.status()]);
    expect(st.log.filter((l) => l.includes("/v1.0/m/token/"))).toHaveLength(1);
  });

  describe("login persistence", () => {
    it("saves the seed on first use", async () => {
      const { valve, storage } = setup();
      await valve.status();
      expect((storage.data.get("tuya:session") as { refreshToken: string }).refreshToken).toBe("ref");
    });

    it("keeps the rotated session when the token is refreshed", async () => {
      const storage = new FakeStorage();
      // the seed's token is already close to expiry, so the first call refreshes it
      const { valve } = setup({ storage, envOver: { TUYA_SESSION: seedJson({ expire_time: 30 }) } });
      await valve.status();
      expect(storage.data.get("tuya:session")).toMatchObject({ accessToken: "tok+", refreshToken: "ref+" });
    });

    it("prefers the saved session over an older seed, and a newer seed over the saved one", async () => {
      const detail = () => [{ online: true, status: [{ code: "switch_1", value: false }] }];
      const saved = { ...sessionFromSeed(seedJson()), loginAt: 2_000_000 };
      const run = async (storage: FakeStorage, seed: string, now: number) =>
        new Valve(storage as unknown as DurableObjectStorage, env({ TUYA_SESSION: seed }), { fetch: fakeServer(newState({ now, handler: detail })), now: () => now, sleep: async () => {} }).status();

      const older = new FakeStorage();
      older.data.set("tuya:session", saved);
      await run(older, seedJson({ t: 1_500_000 }), 1_000_000);
      expect((older.data.get("tuya:session") as { loginAt: number }).loginAt).toBe(2_000_000);

      const newer = new FakeStorage();
      newer.data.set("tuya:session", saved);
      await run(newer, seedJson({ t: 3_000_000, expire_time: 99_999_999 }), 3_000_000);
      expect((newer.data.get("tuya:session") as { loginAt: number }).loginAt).toBe(3_000_000);
    });

    it("explains when there is no login at all", async () => {
      const { valve } = setup({ envOver: { TUYA_SESSION: "" } });
      await expect(valve.status()).rejects.toThrow(/scripts\/tuya-login/);
    });
  });

  describe("reconnecting from the UI", () => {
    /** Tuya's QR login endpoints, in front of the signed API. `scan()` is the user scanning the code in the app. */
    function reconnectSetup(opts: { devices?: boolean } = {}) {
      const st: Parameters<typeof fakeServer>[0] = newState({
        now: 1_000_000,
        failRefresh: "2406",
        handler: (path: string) => (path === "/v1.0/m/life/ha/devices/detail" ? (opts.devices === false ? [] : [{ online: true, status: [{ code: "switch_1", value: false }] }]) : null),
      });
      let scanned = false;
      const signed = fakeServer(st);
      const doFetch = (async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.host !== "apigw.iotbing.com") return signed(input, init);
        if (init?.method === "POST") return Response.json({ success: true, result: { qrcode: "QR123" } });
        if (!scanned) return Response.json({ success: false, code: "1004", msg: "waiting" });
        return Response.json({ success: true, t: st.now, result: { terminal_id: "t2", endpoint: "https://api.test", uid: "uid2", access_token: "ntok", refresh_token: "nref", expire_time: 7200 } });
      }) as typeof fetch;
      const storage = new FakeStorage();
      const clock = { now: st.now };
      const valve = new Valve(storage as unknown as DurableObjectStorage, env({ TUYA_SESSION: seedJson({ expire_time: 30 }) }), { fetch: doFetch, now: () => clock.now, sleep: async () => {} });
      const scan = () => {
        scanned = true;
        st.refresh = "nref";
        st.access = "ntok";
        st.failRefresh = undefined;
      };
      return { valve, storage, scan, clock };
    }

    it("takes a new login from a QR scan and uses it", async () => {
      const { valve, storage, scan } = reconnectSetup();
      await expect(valve.status()).rejects.toThrow(/refuse/i); // the saved login is dead
      expect(await valve.reconnectStart()).toEqual({ state: "waiting", payload: "tuyaSmart--qrLogin?token=QR123" });
      expect(await valve.reconnectCheck()).toMatchObject({ state: "waiting" });
      scan();
      expect(await valve.reconnectCheck()).toEqual({ state: "done" });
      expect(storage.data.get("tuya:session")).toMatchObject({ refreshToken: "nref", userCode: "u" });
      expect(storage.data.has("tuya:pendingQr")).toBe(false);
      expect(await valve.status()).toMatchObject({ online: true, open: false });
    });

    it("keeps the old login when the scanned account cannot see the valve", async () => {
      const { valve, storage, scan } = reconnectSetup({ devices: false });
      await expect(valve.status()).rejects.toThrow();
      const before = storage.data.get("tuya:session");
      await valve.reconnectStart();
      scan();
      await expect(valve.reconnectCheck()).rejects.toThrow(/does not list device/);
      expect(storage.data.get("tuya:session")).toBe(before);
    });

    it("gives up on a code after three minutes, and reports nothing pending otherwise", async () => {
      const { valve, clock } = reconnectSetup();
      expect(await valve.reconnectCheck()).toEqual({ state: "none" });
      await valve.reconnectStart();
      clock.now += 4 * 60_000;
      expect(await valve.reconnectCheck()).toEqual({ state: "expired" });
      expect(await valve.reconnectCheck()).toEqual({ state: "none" });
    });
  });
});

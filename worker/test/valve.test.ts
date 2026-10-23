import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { sessionFromSeed, TuyaAuthError } from "../src/tuya";
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
    expect(await valve.status()).toEqual({ online: true, open: true, batteryPct: 64, countdownSeconds: 540, logins: { live: 1, wanted: 2 } });
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
      expect((storage.data.get("tuya:sessions") as { refreshToken: string }[])[0].refreshToken).toBe("ref");
    });

    it("keeps the rotated session when the token is refreshed", async () => {
      const storage = new FakeStorage();
      // the seed's token is already close to expiry, so the first call refreshes it
      const { valve } = setup({ storage, envOver: { TUYA_SESSION: seedJson({ expire_time: 30 }) } });
      await valve.status();
      expect(storage.data.get("tuya:sessions")).toMatchObject([{ accessToken: "tok+", refreshToken: "ref+" }]);
    });

    it("prefers the saved session over an older seed, and a newer seed over the saved one", async () => {
      const detail = () => [{ online: true, status: [{ code: "switch_1", value: false }] }];
      const saved = { ...sessionFromSeed(seedJson()), loginAt: 2_000_000 };
      const run = async (storage: FakeStorage, seed: string, now: number) =>
        new Valve(storage as unknown as DurableObjectStorage, env({ TUYA_SESSION: seed }), { fetch: fakeServer(newState({ now, handler: detail })), now: () => now, sleep: async () => {} }).status();

      const older = new FakeStorage();
      older.data.set("tuya:sessions", [saved]);
      await run(older, seedJson({ t: 1_500_000 }), 1_000_000);
      expect((older.data.get("tuya:sessions") as { loginAt: number }[]).map((x) => x.loginAt)).toEqual([2_000_000]);

      const newer = new FakeStorage();
      newer.data.set("tuya:sessions", [saved]);
      await run(newer, seedJson({ t: 3_000_000, expire_time: 99_999_999 }), 3_000_000);
      expect((newer.data.get("tuya:sessions") as { loginAt: number }[]).map((x) => x.loginAt)).toEqual([2_000_000, 3_000_000]); // a later login is added beside it
    });

    it("asks for a reconnect when there is no login at all", async () => {
      const { valve } = setup({ envOver: { TUYA_SESSION: "" } });
      await expect(valve.status()).rejects.toThrow(/Reconnect/);
      await expect(valve.status()).rejects.toBeInstanceOf(TuyaAuthError); // so the UI offers the reconnect button
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
      expect(await valve.reconnectCheck()).toEqual({ state: "done", logins: { live: 1, wanted: 2 } });
      expect(storage.data.get("tuya:sessions")).toMatchObject([{ refreshToken: "nref", userCode: "u" }]);
      expect(storage.data.has("tuya:pendingQr")).toBe(false);
      expect(await valve.status()).toMatchObject({ online: true, open: false });
    });

    it("keeps the old login when the scanned account cannot see the valve", async () => {
      const { valve, storage, scan } = reconnectSetup({ devices: false });
      await expect(valve.status()).rejects.toThrow();
      const before = storage.data.get("tuya:sessions");
      await valve.reconnectStart();
      scan();
      await expect(valve.reconnectCheck()).rejects.toThrow(/does not list device/);
      expect(storage.data.get("tuya:sessions")).toBe(before);
    });

    it("can start a reconnect from the User Code alone, with no saved login and no seed", async () => {
      const { valve } = reconnectSetup();
      const bare = new Valve(new FakeStorage() as unknown as DurableObjectStorage, env({ TUYA_SESSION: "", TUYA_USER_CODE: "AB12" }), { fetch: (valve as any).opts.fetch });
      expect(await bare.reconnectStart()).toMatchObject({ state: "waiting" });
      const none = new Valve(new FakeStorage() as unknown as DurableObjectStorage, env({ TUYA_SESSION: "" }), { fetch: (valve as any).opts.fetch });
      await expect(none.reconnectStart()).rejects.toThrow(/tuya_user_code/);
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

  describe("more than one login", () => {
    const login = (loginAt: number, refresh: string, access: string) => ({ ...sessionFromSeed(seedJson({ t: loginAt, refresh_token: refresh, access_token: access })), expireAt: 10_000_000 });

    /** Two separate Tuya refresh chains behind one fetch, routed by whichever token the request carries. */
    function twoLogins(over: { dead?: string[] } = {}) {
      const handler = (path: string) => (path === "/v1.0/m/life/ha/devices/detail" ? [{ online: true, status: [{ code: "switch_1", value: false }] }] : null);
      const chains: Record<"a" | "b", Parameters<typeof fakeServer>[0]> = { a: newState({ now: 1_000_000, handler, refresh: "refA", access: "tokA" }), b: newState({ now: 1_000_000, handler, refresh: "refB", access: "tokB" }) };
      const servers = { a: fakeServer(chains.a), b: fakeServer(chains.b) };
      const doFetch = (async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const token = (init?.headers as Record<string, string>)["X-token"];
        const byToken = Object.entries(chains).find(([, c]) => (url.pathname.startsWith("/v1.0/m/token/") ? url.pathname.endsWith(c.refresh) : c.access === token))?.[0] ?? "a";
        if (over.dead?.includes(byToken)) return Response.json({ success: false, code: "1010", msg: "token is expired" });
        return servers[byToken as "a" | "b"](input, init);
      }) as typeof fetch;
      const storage = new FakeStorage();
      // A is the older login, B the newer one, which is used first.
      storage.data.set("tuya:sessions", [login(1_000, "refA", "tokA"), login(2_000, "refB", "tokB")]);
      const dead: { remaining: number; reason: string }[] = [];
      const valve = new Valve(storage as unknown as DurableObjectStorage, env({ TUYA_SESSION: "" }), { fetch: doFetch, now: () => 1_000_000, sleep: async () => {}, onLoginDead: (d) => void dead.push(d) });
      return { valve, storage, chains, dead, doFetch };
    }

    it("uses the newest login first", async () => {
      const { valve, chains } = twoLogins();
      await valve.status();
      expect(chains.b.log).toEqual(["GET /v1.0/m/life/ha/devices/detail"]);
      expect(chains.a.log).toEqual([]);
    });

    it("moves on to the other login when one is refused, retires it, and says so once", async () => {
      const { valve, storage, dead } = twoLogins({ dead: ["b"] });
      const status = await valve.status();
      expect(status).toMatchObject({ online: true, logins: { live: 1, wanted: 2 } });
      await valve.status();
      expect(dead).toHaveLength(1);
      expect(dead[0].remaining).toBe(1);
      const saved = storage.data.get("tuya:sessions") as { loginAt: number; deadAt?: number }[];
      expect(saved.find((s) => s.loginAt === 2_000)?.deadAt).toBeTruthy();
      expect(saved.find((s) => s.loginAt === 1_000)?.deadAt).toBeUndefined();
    });

    it("fails with a login error, and an alert for the last one, when every login is refused", async () => {
      const { valve, dead } = twoLogins({ dead: ["a", "b"] });
      await expect(valve.status()).rejects.toBeInstanceOf(TuyaAuthError);
      expect(dead.map((d) => d.remaining)).toEqual([1, 0]);
    });

    it("does not retry a command on the other login after a network failure", async () => {
      const { valve, chains } = twoLogins();
      chains.b.netDown = true;
      await expect(valve.status()).rejects.toThrow(/fetch failed/);
      expect(chains.a.log).toEqual([]);
    });

    it("keeps the spare login alive by refreshing it, and notices when it has died", async () => {
      const { valve, chains, dead } = twoLogins({ dead: ["a"] });
      // both access tokens are due for a refresh
      const sessions = (valve as any).storage.data.get("tuya:sessions") as { expireAt: number }[];
      for (const s of sessions) s.expireAt = 0;
      await valve.keepWarm();
      expect(chains.b.log).toEqual(["GET /v1.0/m/token/refB"]);
      expect(dead).toEqual([{ remaining: 1, reason: expect.stringContaining("1010") }]);
    });

    // The QR endpoints hand out the login that chain B already knows.
    const withQr = (signed: typeof fetch) =>
      (async (input: string | URL, init?: RequestInit) => {
        if (new URL(String(input)).host !== "apigw.iotbing.com") return signed(input, init);
        if (init?.method === "POST") return Response.json({ success: true, result: { qrcode: "QR1" } });
        return Response.json({ success: true, t: 3_000, result: { terminal_id: "tb", endpoint: "https://api.test", uid: "u", access_token: "tokB", refresh_token: "refB", expire_time: 7200 } });
      }) as typeof fetch;

    async function reconnectWith(dead: string[]) {
      const base = twoLogins({ dead });
      const storage = new FakeStorage();
      storage.data.set("tuya:sessions", [login(1_000, "refA", "tokA")]);
      const valve = new Valve(storage as unknown as DurableObjectStorage, env({ TUYA_SESSION: "" }), { fetch: withQr(base.doFetch), now: () => 1_000_000, sleep: async () => {} });
      await valve.reconnectStart();
      return { done: await valve.reconnectCheck(), storage, valve };
    }

    it("adds a second login on reconnect and keeps the first when Tuya honours both", async () => {
      const { done, valve } = await reconnectWith([]);
      expect(done).toEqual({ state: "done", logins: { live: 2, wanted: 2 } });
      expect((await valve.status()).logins.live).toBe(2);
    });

    it("reports plainly when signing in again signed the older login out", async () => {
      const { done, storage } = await reconnectWith(["a"]);
      expect(done).toEqual({ state: "done", logins: { live: 1, wanted: 2 } });
      expect((storage.data.get("tuya:sessions") as { deadAt?: number }[]).some((s) => s.deadAt)).toBe(true);
    });

    it("moves a single login saved by an older version into the list", async () => {
      const storage = new FakeStorage();
      storage.data.set("tuya:session", login(1_000, "refA", "tokA"));
      const { doFetch } = twoLogins();
      const valve = new Valve(storage as unknown as DurableObjectStorage, env({ TUYA_SESSION: "" }), { fetch: doFetch, now: () => 1_000_000, sleep: async () => {} });
      await valve.status();
      expect(storage.data.has("tuya:session")).toBe(false);
      expect((storage.data.get("tuya:sessions") as unknown[]).length).toBe(1);
    });
  });
});

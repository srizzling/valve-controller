import { describe, expect, it } from "vitest";
import { decrypt, deriveSecret, encrypt, md5, sessionFromSeed, sign, TuyaAuthError, TuyaClient, TuyaError } from "../src/tuya";
import type { TuyaSession } from "../src/tuya";
import { baseSession, fakeServer, newState } from "./helpers/fakeTuya";
import V from "./vectors/tuya.json";

// Produced by Tuya's own Python SDK, so a pass means this port is byte-compatible with it.
const NONCE = "ABCDEFGHJKMN";

describe("crypto matches Tuya's SDK", () => {
  it("md5 gives the standard digests, including at the padding boundaries", () => {
    const cases: [string, string][] = [
      ["", "d41d8cd98f00b204e9800998ecf8427e"],
      ["abc", "900150983cd24fb0d6963f7d28e17f72"],
      ["a".repeat(55), "ef1772b6dff9a122358552954ad0df65"],
      ["a".repeat(56), "3b0c8ac703f828b04c6c197006d17218"],
      ["a".repeat(64), "014842d480b571495a4a0363793f7367"],
      ["x".repeat(1000), "398533d48111e9f664b1f64cb10c4b63"],
      ["héllo ☃", "ef3e44ec264a71ab40ccc920b794ebae"],
    ];
    for (const [input, digest] of cases) expect(md5(input)).toBe(digest);
  });
  it("derives the same hash key and secret", async () => {
    expect(md5(V.rid + V.refresh_token)).toBe(V.hash_key);
    expect(await deriveSecret(V.rid, V.hash_key)).toBe(V.secret);
  });
  it("encrypts to the same bytes and decrypts the SDK's output", async () => {
    expect(await encrypt(V.body, V.secret, NONCE)).toBe(V.enc_body);
    expect(await encrypt(V.query, V.secret, NONCE)).toBe(V.enc_query);
    expect(await decrypt(V.decrypt_input, V.secret)).toBe(V.decrypt_expected);
  });
  it("signs the same way, with and without a token or payload", async () => {
    expect(await sign(V.hash_key, V.enc_query, V.enc_body, V.headers)).toBe(V.sign_with_query_and_body);
    expect(await sign(V.hash_key, "", V.enc_body, V.headers)).toBe(V.sign_body_only);
    const { "X-token": _t, ...noToken } = V.headers;
    expect(await sign(V.hash_key, "", "", noToken)).toBe(V.sign_no_token_no_payload);
  });
});

describe("session seed", () => {
  const seed = { client_id: "c", user_code: "u", terminal_id: "t", endpoint: "https://apigw.example.com/", uid: "id", access_token: "a", refresh_token: "r", expire_time: 7200, t: 1_000_000 };
  it("converts Tuya's login result", () => {
    expect(sessionFromSeed(JSON.stringify(seed))).toMatchObject({ clientId: "c", endpoint: "https://apigw.example.com", accessToken: "a", refreshToken: "r", expireAt: 1_000_000 + 7_200_000, loginAt: 1_000_000 });
  });
  it("names the missing field", () => {
    expect(() => sessionFromSeed(JSON.stringify({ ...seed, refresh_token: "" }))).toThrow(/refresh_token/);
  });
});

describe("TuyaClient", () => {
  it("sends signed, encrypted commands to the right path", async () => {
    const st = newState({ handler: (_p: string, _q: unknown, body: unknown) => ({ echoed: body }) });
    const c = new TuyaClient(baseSession(), { fetch: fakeServer(st), now: () => st.now });
    const r = await c.sendCommands("dev1", [{ code: "switch_1", value: true }]);
    expect(r).toEqual({ echoed: { commands: [{ code: "switch_1", value: true }] } });
    expect(st.log).toEqual(["POST /v1.1/m/thing/dev1/commands"]);
  });

  it("does not refresh while the token is fresh", async () => {
    const st = newState();
    await new TuyaClient(baseSession(), { fetch: fakeServer(st), now: () => st.now }).sendCommands("d", []);
    expect(st.log.some((l) => l.includes("/token/"))).toBe(false);
  });

  it("refreshes an expiring token, saves the rotated session, and uses it afterwards", async () => {
    const st = newState();
    const saved: TuyaSession[] = [];
    const c = new TuyaClient(baseSession({ expireAt: st.now + 30_000 }), { fetch: fakeServer(st), now: () => st.now, onSession: (s) => void saved.push(s) });
    await c.sendCommands("d", [{ code: "x", value: 1 }]);
    expect(st.log).toEqual(["GET /v1.0/m/token/ref", "POST /v1.1/m/thing/d/commands"]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ accessToken: "tok+", refreshToken: "ref+", uid: "uid1", expireAt: st.now + 7_200_000 });
    await c.sendCommands("d", []); // signed with the new refresh token, so the fake server would reject a stale one
    expect(st.log).toHaveLength(3);
  });

  it("shares one refresh between concurrent requests", async () => {
    const st = newState();
    const c = new TuyaClient(baseSession({ expireAt: 0 }), { fetch: fakeServer(st), now: () => st.now });
    await Promise.all([c.sendCommands("d", []), c.sendCommands("d", []), c.deviceStatus("d").catch(() => undefined)]);
    expect(st.log.filter((l) => l.includes("/token/"))).toHaveLength(1);
  });

  it("adopts a newer saved session instead of giving up when its own refresh token was already rotated", async () => {
    const st = newState({ refresh: "ref2", access: "tok2" });
    const newer = baseSession({ refreshToken: "ref2", accessToken: "tok2", expireAt: st.now + 3_600_000, loginAt: 1 });
    const stale = baseSession({ expireAt: st.now - 1 });
    const c = new TuyaClient(stale, { fetch: fakeServer(st), now: () => st.now, reload: () => newer });
    await c.sendCommands("d", []);
    expect(c.getSession().refreshToken).toBe("ref2");
  });

  it("raises an auth error when Tuya refuses the refresh, but not on a network failure", async () => {
    const refused = newState({ failRefresh: "1010" });
    await expect(new TuyaClient(baseSession({ expireAt: 0 }), { fetch: fakeServer(refused), now: () => refused.now }).sendCommands("d", [])).rejects.toBeInstanceOf(TuyaAuthError);
    const down = newState({ netDown: true });
    const err = await new TuyaClient(baseSession({ expireAt: 0 }), { fetch: fakeServer(down), now: () => down.now }).sendCommands("d", []).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TuyaAuthError);
    expect(err).toBeInstanceOf(TypeError);
  });

  it("surfaces API errors with their code", async () => {
    const st = newState({ access: "different" }); // the server no longer accepts the client's token
    const err = await new TuyaClient(baseSession(), { fetch: fakeServer(st), now: () => st.now }).sendCommands("d", []).catch((e: unknown) => e as TuyaError);
    expect(err).toBeInstanceOf(TuyaError);
    expect((err as TuyaError).code).toBe("1010");
  });

  it("reads a device's status as a code to value map", async () => {
    const st = newState({ handler: (p: string, q: any) => (p === "/v1.0/m/life/ha/devices/detail" && q.devIds === "dev1" ? [{ online: true, status: [{ code: "switch_1", value: false }, { code: "battery_percentage", value: 87 }] }] : []) });
    const c = new TuyaClient(baseSession(), { fetch: fakeServer(st), now: () => st.now });
    expect(await c.deviceStatus("dev1")).toEqual({ online: true, status: { switch_1: false, battery_percentage: 87 } });
    await expect(c.deviceStatus("nope")).rejects.toThrow(/does not list/);
  });
});

import { decrypt, deriveSecret, encrypt, md5, sign } from "../../src/tuya";
import type { TuyaSession } from "../../src/tuya";

// A stand-in for Tuya's server that checks signatures and encryption the way the real one must.
export function fakeServer(state: { refresh: string; access: string; now: number; log: string[]; failRefresh?: string; netDown?: boolean; handler?: (path: string, params: any, body: any) => unknown }) {
  return (async (input: string | URL, init: RequestInit = {}) => {
    if (state.netDown) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const h = init.headers as Record<string, string>;
    const hashKey = md5(h["X-requestId"] + state.refresh);
    const secret = await deriveSecret(h["X-requestId"], hashKey);
    const q = url.searchParams.get("encdata") ?? "";
    const bodyEnc = init.body ? JSON.parse(String(init.body)).encdata : "";
    const expected = await sign(hashKey, q, bodyEnc, h);
    if (expected !== h["X-sign"]) return new Response(JSON.stringify({ success: false, code: "1004", msg: "sign invalid" }));
    const params = q ? JSON.parse(await decrypt(q, secret)) : undefined;
    const body = bodyEnc ? JSON.parse(await decrypt(bodyEnc, secret)) : undefined;
    state.log.push(`${init.method} ${url.pathname}`);
    const reply = async (result: unknown) => new Response(JSON.stringify({ success: true, t: state.now, result: await encrypt(JSON.stringify(result), secret) }));
    if (url.pathname.startsWith("/v1.0/m/token/")) {
      if (state.failRefresh) return new Response(JSON.stringify({ success: false, code: state.failRefresh, msg: "refresh token invalid" }));
      if (url.pathname.endsWith(state.refresh) === false) return new Response(JSON.stringify({ success: false, code: "1010", msg: "token invalid" }));
      state.refresh = `${state.refresh}+`;
      state.access = `${state.access}+`;
      return reply({ expireTime: 7200, uid: "uid1", accessToken: state.access, refreshToken: state.refresh });
    }
    if (h["X-token"] !== state.access) return new Response(JSON.stringify({ success: false, code: "1010", msg: "token invalid" }));
    return reply(state.handler?.(url.pathname, params, body) ?? true);
  }) as unknown as typeof fetch;
}

export const baseSession = (over: Partial<TuyaSession> = {}): TuyaSession => ({ clientId: "client", userCode: "u", terminalId: "t", endpoint: "https://api.test", uid: "uid0", accessToken: "tok", refreshToken: "ref", expireAt: 10_000_000, loginAt: 1, ...over });
export const newState = (over = {}) => ({ refresh: "ref", access: "tok", now: 1_000_000, log: [] as string[], ...over });


// Client for Tuya's cloud as the Smart Life app uses it (the "device sharing" API that Home Assistant's Tuya
// integration is built on). Ported from Tuya's MIT-licensed tuya-device-sharing-sdk, and checked against that
// library's own output in test/vectors/tuya.json.
//
// Every request is signed and its query and body are AES-GCM encrypted with a key derived from the current refresh
// token. The refresh token rotates each time it is used, so the session must be saved whenever it changes.

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface TuyaSession {
  clientId: string;
  userCode: string;
  terminalId: string;
  endpoint: string;
  uid: string;
  accessToken: string;
  refreshToken: string;
  expireAt: number; // epoch ms
  loginAt: number; // epoch ms of the QR login: a newer seed replaces an older saved session
}

export class TuyaError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/** The login can no longer be refreshed: someone has to scan a new QR code, in the UI or with scripts/tuya-login.py. */
export class TuyaAuthError extends TuyaError {}

/** The JSON that scripts/tuya-login.py writes (Tuya's own field names). */
export function sessionFromSeed(json: string): TuyaSession {
  const s = JSON.parse(json) as Record<string, string | number>;
  for (const k of ["client_id", "user_code", "terminal_id", "endpoint", "access_token", "refresh_token", "expire_time", "t"]) {
    if (s[k] === undefined || s[k] === "") throw new Error(`Tuya session seed is missing "${k}"`);
  }
  return {
    clientId: String(s.client_id),
    userCode: String(s.user_code),
    terminalId: String(s.terminal_id),
    endpoint: String(s.endpoint).replace(/\/+$/, ""),
    uid: String(s.uid ?? ""),
    accessToken: String(s.access_token),
    refreshToken: String(s.refresh_token),
    expireAt: Number(s.t) + Number(s.expire_time) * 1000,
    loginAt: Number(s.t),
  };
}

// ───────────── QR login ─────────────
// The same two unsigned calls that scripts/tuya-login.py makes through Tuya's SDK: ask for a QR token, then poll until
// someone scans it in the Smart Life app. Lets the Worker take a new login without the script or a deploy.

const LOGIN_HOST = "https://apigw.iotbing.com";
const LOGIN_SCHEMA = "haauthorize";
/** Home Assistant's registered client id, the only one Tuya's QR login accepts for third-party tools. */
export const HA_CLIENT_ID = "HA_3y9q4ak7g4ephrvke";

/** What the Smart Life app's scanner reads from the QR code. */
export const qrPayload = (token: string) => `tuyaSmart--qrLogin?token=${token}`;

export async function startQrLogin(userCode: string, doFetch: typeof fetch = fetch): Promise<string> {
  const url = `${LOGIN_HOST}/v1.0/m/life/home-assistant/qrcode/tokens?clientid=${HA_CLIENT_ID}&usercode=${encodeURIComponent(userCode)}&schema=${LOGIN_SCHEMA}`;
  const res = await doFetch(url, { method: "POST", signal: AbortSignal.timeout(20_000) });
  const env = (await res.json()) as { success?: boolean; msg?: string; code?: string | number; result?: { qrcode?: string } };
  if (!env.success || !env.result?.qrcode) throw new TuyaError(`Tuya refused the login request: ${env.msg ?? env.code ?? `HTTP ${res.status}`}`, String(env.code ?? ""));
  return env.result.qrcode;
}

/** The new login once the QR code has been scanned, or null while it is still waiting. */
export async function checkQrLogin(token: string, userCode: string, doFetch: typeof fetch = fetch): Promise<TuyaSession | null> {
  const url = `${LOGIN_HOST}/v1.0/m/life/home-assistant/qrcode/tokens/${encodeURIComponent(token)}?clientid=${HA_CLIENT_ID}&usercode=${encodeURIComponent(userCode)}`;
  const res = await doFetch(url, { signal: AbortSignal.timeout(20_000) });
  const env = (await res.json()) as { success?: boolean; t?: number; result?: Record<string, string | number> };
  if (!env.success || !env.result) return null;
  return sessionFromSeed(JSON.stringify({ client_id: HA_CLIENT_ID, user_code: userCode, ...env.result, t: env.t }));
}

// ───────────── crypto ─────────────

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** MD5 is not in WebCrypto for every runtime, and the protocol needs it exactly once per request. */
export function md5(input: string): string {
  const bytes = enc.encode(input);
  const total = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, (bytes.length * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor((bytes.length * 8) / 2 ** 32), true);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => view.getUint32(off + i * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      const s = S[(i >> 4) * 4 + (i % 4)];
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  return hex(out.buffer);
}

async function hmacSha256(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

/** The per-request AES key: the first 16 hex characters of HMAC-SHA256(rid, md5(rid + refreshToken)). */
export async function deriveSecret(rid: string, hashKey: string): Promise<string> {
  return (await hmacSha256(rid, hashKey)).slice(0, 16);
}

const NONCE_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
const randomNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => NONCE_ALPHABET[b % NONCE_ALPHABET.length]).join("");

const aesKey = (secret: string, use: "encrypt" | "decrypt") => crypto.subtle.importKey("raw", enc.encode(secret), "AES-GCM", false, [use]);

/** base64(nonce) followed by base64(ciphertext and tag), the format the API expects. */
export async function encrypt(raw: string, secret: string, nonce = randomNonce()): Promise<string> {
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: enc.encode(nonce), tagLength: 128 }, await aesKey(secret, "encrypt"), enc.encode(raw)));
  return toB64(enc.encode(nonce)) + toB64(ct);
}

export async function decrypt(b64: string, secret: string): Promise<string> {
  const all = fromB64(b64);
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12), tagLength: 128 }, await aesKey(secret, "decrypt"), all.slice(12)));
}

const SIGNED_HEADERS = ["X-appKey", "X-requestId", "X-sid", "X-time", "X-token"];

export async function sign(hashKey: string, queryEnc: string, bodyEnc: string, headers: Record<string, string>): Promise<string> {
  let str = SIGNED_HEADERS.filter((h) => (headers[h] ?? "") !== "").map((h) => `${h}=${headers[h]}`).join("||");
  str += queryEnc + bodyEnc;
  return hmacSha256(hashKey, str);
}

// ───────────── client ─────────────

export interface TuyaOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Called with the new session whenever the tokens rotate. Save it before anything else uses the old one. */
  onSession?: (s: TuyaSession) => Promise<void> | void;
  /** The saved session. If Tuya refuses our refresh token, something else may already have rotated it. */
  reload?: () => Promise<TuyaSession | undefined> | TuyaSession | undefined;
  uuid?: () => string;
}

interface Envelope {
  success: boolean;
  code?: string | number;
  msg?: string;
  result?: unknown;
  t?: number;
}

export class TuyaClient {
  private refreshing?: Promise<void>;

  constructor(private session: TuyaSession, private opts: TuyaOptions = {}) {}

  getSession(): TuyaSession {
    return this.session;
  }

  private now = () => (this.opts.now ?? Date.now)();

  async request<T = unknown>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, body?: Record<string, unknown>): Promise<T> {
    await this.ensureFresh();
    return this.send<T>(method, path, params, body);
  }

  private async ensureFresh(): Promise<void> {
    if (this.session.expireAt - 60_000 > this.now()) return;
    // One refresh at a time: the old refresh token stops working as soon as the new one is issued.
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = undefined));
    await this.refreshing;
  }

  private async refresh(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const env = await this.sendRaw("GET", `/v1.0/m/token/${this.session.refreshToken}`);
        const r = env.result as { expireTime: number; uid: string; accessToken: string; refreshToken: string };
        this.session = { ...this.session, accessToken: r.accessToken, refreshToken: r.refreshToken, uid: r.uid, expireAt: (env.t ?? this.now()) + r.expireTime * 1000 };
        await this.opts.onSession?.(this.session);
        return;
      } catch (e) {
        if (!(e instanceof TuyaError && e.code)) throw e; // a network problem is not a reason to give up on the login
        // Before declaring the login dead, check whether a newer one was saved since this client loaded its own.
        const saved = attempt === 0 ? await this.opts.reload?.() : undefined;
        if (saved && saved.loginAt >= this.session.loginAt && saved.refreshToken !== this.session.refreshToken) {
          this.session = saved;
          if (saved.expireAt - 60_000 > this.now()) return;
          continue;
        }
        throw new TuyaAuthError(`Tuya refused to refresh the login (${e.code}: ${e.message}). Reconnect it from the UI (the 🔑 chip), or run scripts/tuya-login.py again.`, e.code);
      }
    }
  }

  private async send<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, body?: Record<string, unknown>): Promise<T> {
    return (await this.sendRaw(method, path, params, body)).result as T;
  }

  private async sendRaw(method: "GET" | "POST", path: string, params?: Record<string, unknown>, body?: Record<string, unknown>): Promise<Envelope & { result: unknown }> {
    const s = this.session;
    const rid = (this.opts.uuid ?? (() => crypto.randomUUID()))();
    const hashKey = md5(rid + s.refreshToken);
    const secret = await deriveSecret(rid, hashKey);

    const queryEnc = params && Object.keys(params).length ? await encrypt(JSON.stringify(params), secret) : "";
    const bodyEnc = body && Object.keys(body).length ? await encrypt(JSON.stringify(body), secret) : "";
    const headers: Record<string, string> = { "X-appKey": s.clientId, "X-requestId": rid, "X-sid": "", "X-time": String(this.now()) };
    if (s.accessToken) headers["X-token"] = s.accessToken;
    headers["X-sign"] = await sign(hashKey, queryEnc, bodyEnc, headers);

    const url = `${s.endpoint}${path}${queryEnc ? `?encdata=${encodeURIComponent(queryEnc)}` : ""}`;
    const res = await (this.opts.fetch ?? fetch)(url, {
      method,
      headers: bodyEnc ? { ...headers, "content-type": "application/json" } : headers,
      body: bodyEnc ? JSON.stringify({ encdata: bodyEnc }) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new TuyaError(`Tuya returned HTTP ${res.status}`);
    const env = (await res.json()) as Envelope;
    if (!env.success) throw new TuyaError(String(env.msg ?? "request failed"), String(env.code ?? "unknown"));
    if (typeof env.result === "string" && env.result) {
      const text = await decrypt(env.result, secret);
      try {
        env.result = JSON.parse(text);
      } catch {
        env.result = text;
      }
    }
    return env as Envelope & { result: unknown };
  }

  // ───────────── the few calls the controller needs ─────────────

  sendCommands(deviceId: string, commands: { code: string; value: unknown }[]): Promise<unknown> {
    return this.request("POST", `/v1.1/m/thing/${deviceId}/commands`, undefined, { commands });
  }

  /** The device record, including its current status as [{code, value}]. */
  async deviceStatus(deviceId: string): Promise<{ online: boolean; status: Record<string, unknown> }> {
    const list = await this.request<{ online: boolean; status: { code: string; value: unknown }[] }[]>("GET", "/v1.0/m/life/ha/devices/detail", { devIds: deviceId });
    const d = list?.[0];
    if (!d) throw new TuyaError(`Tuya does not list device ${deviceId} on this account`);
    return { online: !!d.online, status: Object.fromEntries((d.status ?? []).map((x) => [x.code, x.value])) };
  }
}

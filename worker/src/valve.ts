import type { Env } from "./env";
import { checkQrLogin, qrPayload, sessionFromSeed, startQrLogin, TuyaAuthError, TuyaClient } from "./tuya";
import type { TuyaSession } from "./tuya";

const SESSIONS_KEY = "tuya:sessions";
const LEGACY_SESSION_KEY = "tuya:session"; // before there could be more than one login
const PENDING_QR_KEY = "tuya:pendingQr";
const QR_LIFETIME_MS = 3 * 60_000; // Tuya's QR codes stop working after about this long

/** Independent logins to keep. Each is its own refresh chain, so one dying does not stop the valve. */
export const MAX_LOGINS = 2;

// The valve closes itself this long after it was meant to, if the Worker never sends the close. It is the
// failsafe the homelab agent's timer used to be. It only applies when the valve has a countdown function.
const FAILSAFE_MARGIN_SECONDS = 90;

export interface ValveStatus {
  online: boolean;
  open: boolean;
  batteryPct?: number;
  countdownSeconds?: number;
  logins: { live: number; wanted: number };
}

export type Reconnect =
  | { state: "waiting"; payload: string }
  | { state: "done"; logins: { live: number; wanted: number } }
  | { state: "expired" }
  | { state: "none" };

export interface ValveOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** A login stopped working. `remaining` is how many still work, so 0 means the valve is out of reach. */
  onLoginDead?: (info: { remaining: number; reason: string }) => Promise<void> | void;
}

interface Login {
  id: number; // the session's loginAt
  client: TuyaClient;
}

/** The garden valve, reached through Tuya's cloud with up to MAX_LOGINS independent logins; the first working one is used. */
export class Valve {
  private logins?: Promise<Login[]>;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private storage: DurableObjectStorage, private env: Env, private opts: ValveOptions = {}) {}

  private get switchCode() {
    return this.env.TUYA_SWITCH_CODE || "switch_1";
  }

  private get countdownCode() {
    return this.env.TUYA_COUNTDOWN_CODE ?? "countdown_1"; // set it to an empty string for a valve without one
  }

  private now = () => (this.opts.now ?? Date.now)();

  // ───────────── the saved logins ─────────────

  private async readSessions(): Promise<TuyaSession[]> {
    const list = await this.storage.get<TuyaSession[]>(SESSIONS_KEY);
    if (list) return list;
    const legacy = await this.storage.get<TuyaSession>(LEGACY_SESSION_KEY);
    return legacy ? [legacy] : [];
  }

  /** Changes the saved logins one change at a time: each refreshing login saves its own tokens as they rotate. */
  private edit(change: (list: TuyaSession[]) => TuyaSession[]): Promise<TuyaSession[]> {
    const run = this.writes.then(async () => {
      const next = change(await this.readSessions());
      await this.storage.put(SESSIONS_KEY, next);
      return next;
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  private newClient(s: TuyaSession): Login {
    const client = new TuyaClient(s, {
      fetch: this.opts.fetch,
      now: this.opts.now,
      onSession: async (fresh) => void (await this.edit((list) => list.map((x) => (x.loginAt === s.loginAt ? { ...fresh, deadAt: x.deadAt, deadReason: x.deadReason } : x)))),
      reload: async () => (await this.readSessions()).find((x) => x.loginAt === s.loginAt),
    });
    return { id: s.loginAt, client };
  }

  // The promise is what is kept, so requests that arrive together on a cold start share one set of clients instead of
  // each refreshing the same token (Tuya treats a reused refresh token as theft).
  private live(): Promise<Login[]> {
    return (this.logins ??= this.loadLogins().catch((e) => {
      this.logins = undefined;
      throw e;
    }));
  }

  private async loadLogins(): Promise<Login[]> {
    let list = await this.readSessions();
    const seed = this.env.TUYA_SESSION ? sessionFromSeed(this.env.TUYA_SESSION) : undefined;
    // A saved login has the newest rotating tokens, so it wins, unless a later login was deployed.
    if (seed && !list.some((s) => s.loginAt >= seed.loginAt)) list = addLogin(list, seed);
    await this.edit(() => list); // also moves a single login saved by an older version into the list
    await this.storage.delete(LEGACY_SESSION_KEY);
    return list.filter((s) => !s.deadAt).sort((a, b) => b.loginAt - a.loginAt).map((s) => this.newClient(s)); // newest first
  }

  private async markDead(id: number, reason: string): Promise<void> {
    await this.edit((list) => list.map((s) => (s.loginAt === id && !s.deadAt ? { ...s, deadAt: this.now(), deadReason: reason } : s)));
    const logins = await this.live();
    const i = logins.findIndex((l) => l.id === id);
    if (i < 0) return; // already dealt with by another request
    logins.splice(i, 1);
    await this.opts.onLoginDead?.({ remaining: logins.length, reason });
  }

  /** Runs `fn` with the first working login. A login Tuya refuses to refresh is retired and the next one is tried. */
  private async withTuya<T>(fn: (c: TuyaClient) => Promise<T>): Promise<T> {
    let lastError: TuyaAuthError | undefined;
    for (;;) {
      const first = (await this.live())[0];
      if (!first) throw lastError ?? new TuyaAuthError("No working Tuya login is saved. Reconnect it from the UI (the 🔑 chip), or run scripts/tuya-login.py.");
      try {
        return await fn(first.client);
      } catch (e) {
        if (!(e instanceof TuyaAuthError)) throw e; // only a refused refresh, which happens before anything is sent
        lastError = e;
        await this.markDead(first.id, e.message);
      }
    }
  }

  private async summary(): Promise<{ live: number; wanted: number }> {
    return { live: (await this.live()).length, wanted: MAX_LOGINS };
  }

  /** Keeps every login refreshed, including the ones not in use: a spare that is never touched may be let go by Tuya. */
  async keepWarm(): Promise<void> {
    for (const login of [...(await this.live())]) {
      try {
        await login.client.refreshIfNeeded();
      } catch (e) {
        if (e instanceof TuyaAuthError) await this.markDead(login.id, e.message);
        // anything else is a network problem: try again next minute
      }
    }
  }

  // ───────────── signing in again ─────────────

  /** Starts a QR login. The user code comes from a login we already have, so nothing new needs configuring. */
  async reconnectStart(): Promise<Reconnect & { state: "waiting" }> {
    const known = (await this.readSessions()).find((s) => s.userCode);
    const userCode = known?.userCode || this.env.TUYA_USER_CODE || (this.env.TUYA_SESSION ? sessionFromSeed(this.env.TUYA_SESSION).userCode : "");
    if (!userCode) throw new Error("No Tuya User Code is known. Set tuya_user_code in infra/terraform.tfvars (Smart Life app: Me > settings > Account and Security > User Code) and apply Terraform.");
    const token = await startQrLogin(userCode, this.opts.fetch);
    await this.storage.put(PENDING_QR_KEY, { token, userCode, startedAt: this.now() });
    return { state: "waiting", payload: qrPayload(token) };
  }

  /** The QR code being scanned in the app is what finishes the login, so poll this until it says done. */
  async reconnectCheck(): Promise<Reconnect> {
    const pending = await this.storage.get<{ token: string; userCode: string; startedAt: number }>(PENDING_QR_KEY);
    if (!pending) return { state: "none" };
    if (this.now() - pending.startedAt > QR_LIFETIME_MS) {
      await this.storage.delete(PENDING_QR_KEY);
      return { state: "expired" };
    }
    const session = await checkQrLogin(pending.token, pending.userCode, this.opts.fetch);
    if (!session) return { state: "waiting", payload: qrPayload(pending.token) };
    // Do not take a login that cannot see the valve, such as a scan from the wrong Smart Life account.
    const probe = new TuyaClient(session, { fetch: this.opts.fetch, now: this.opts.now });
    await probe.deviceStatus(this.env.TUYA_DEVICE_ID);
    await this.edit((list) => addLogin(list, probe.getSession())); // after the call: it may have refreshed the tokens
    await this.storage.delete(PENDING_QR_KEY);
    this.logins = undefined;
    // Signing in again may sign the older logins out, so find out now rather than at the next run.
    const added = probe.getSession().loginAt;
    for (const login of [...(await this.live())]) {
      if (login.id === added) continue;
      try {
        await login.client.refreshNow();
      } catch (e) {
        if (e instanceof TuyaAuthError) await this.markDead(login.id, e.message);
      }
    }
    return { state: "done", logins: await this.summary() };
  }

  // ───────────── the valve ─────────────

  async status(): Promise<ValveStatus> {
    const { online, status } = await this.withTuya((c) => c.deviceStatus(this.env.TUYA_DEVICE_ID));
    return {
      online,
      open: status[this.switchCode] === true,
      batteryPct: typeof status.battery_percentage === "number" ? status.battery_percentage : undefined,
      countdownSeconds: this.countdownCode && typeof status[this.countdownCode] === "number" ? (status[this.countdownCode] as number) : undefined,
      logins: await this.summary(),
    };
  }

  /** Open the valve for `seconds` (plus a margin the valve enforces itself) and confirm it reports open. */
  async open(seconds: number): Promise<void> {
    const commands: { code: string; value: unknown }[] = [{ code: this.switchCode, value: true }];
    if (this.countdownCode) commands.push({ code: this.countdownCode, value: Math.round(seconds) + FAILSAFE_MARGIN_SECONDS });
    await this.withTuya((c) => c.sendCommands(this.env.TUYA_DEVICE_ID, commands));
    await this.confirm(true);
  }

  async close(): Promise<void> {
    await this.withTuya((c) => c.sendCommands(this.env.TUYA_DEVICE_ID, [{ code: this.switchCode, value: false }]));
    await this.confirm(false);
  }

  // A command being accepted is not the valve doing it, so ask the valve before saying it is done.
  private async confirm(wantOpen: boolean): Promise<void> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(1500);
      if ((await this.status()).open === wantOpen) return;
    }
    throw new Error(`The valve did not report ${wantOpen ? "open" : "closed"} after the command.`);
  }
}

/** Adds a login: working ones are kept (dead ones are dropped), and past the limit the oldest one makes way. */
export function addLogin(list: TuyaSession[], added: TuyaSession): TuyaSession[] {
  const kept = [...list.filter((s) => !s.deadAt && s.loginAt !== added.loginAt), added].sort((a, b) => a.loginAt - b.loginAt);
  return kept.slice(-MAX_LOGINS);
}

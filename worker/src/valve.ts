import type { Env } from "./env";
import { checkQrLogin, qrPayload, sessionFromSeed, startQrLogin, TuyaClient } from "./tuya";
import type { TuyaSession } from "./tuya";

const SESSION_KEY = "tuya:session";
const PENDING_QR_KEY = "tuya:pendingQr";
const QR_LIFETIME_MS = 3 * 60_000; // Tuya's QR codes stop working after about this long

// The valve closes itself this long after it was meant to, if the Worker never sends the close. It is the
// failsafe the homelab agent's timer used to be. It only applies when the valve has a countdown function.
const FAILSAFE_MARGIN_SECONDS = 90;

export interface ValveStatus {
  online: boolean;
  open: boolean;
  batteryPct?: number;
  countdownSeconds?: number;
}

export type Reconnect = { state: "waiting"; payload: string } | { state: "done" } | { state: "expired" } | { state: "none" };

export interface ValveOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The garden valve, reached through Tuya's cloud. */
export class Valve {
  private client?: Promise<TuyaClient>;

  constructor(private storage: DurableObjectStorage, private env: Env, private opts: ValveOptions = {}) {}

  private get switchCode() {
    return this.env.TUYA_SWITCH_CODE || "switch_1";
  }

  private get countdownCode() {
    return this.env.TUYA_COUNTDOWN_CODE ?? "countdown_1"; // set it to an empty string for a valve without one
  }

  // One client per Worker instance. It is the promise that is kept, so two requests that arrive together on a cold
  // start share one client instead of each refreshing the same token (Tuya treats a reused refresh token as theft).
  private tuya(): Promise<TuyaClient> {
    return (this.client ??= this.makeClient().catch((e) => {
      this.client = undefined;
      throw e;
    }));
  }

  private async makeClient(): Promise<TuyaClient> {
    const saved = await this.storage.get<TuyaSession>(SESSION_KEY);
    const seed = this.env.TUYA_SESSION ? sessionFromSeed(this.env.TUYA_SESSION) : undefined;
    // The saved session has the newest rotating tokens, so it wins, unless a later login was deployed.
    const session = saved && (!seed || saved.loginAt >= seed.loginAt) ? saved : seed;
    if (!session) throw new Error("No Tuya login is configured. Run scripts/tuya-login.py, then apply Terraform.");
    if (session !== saved) await this.storage.put(SESSION_KEY, session);
    return new TuyaClient(session, {
      fetch: this.opts.fetch,
      now: this.opts.now,
      onSession: (s) => this.storage.put(SESSION_KEY, s),
      reload: () => this.storage.get<TuyaSession>(SESSION_KEY),
    });
  }

  /** Starts a QR login. The user code comes from the login we already have, so nothing new needs configuring. */
  async reconnectStart(): Promise<Reconnect & { state: "waiting" }> {
    const userCode = (await this.storage.get<TuyaSession>(SESSION_KEY))?.userCode ?? (this.env.TUYA_SESSION ? sessionFromSeed(this.env.TUYA_SESSION).userCode : "");
    if (!userCode) throw new Error("No Tuya User Code is known. Run scripts/tuya-login.py once to set one up.");
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
    // Do not trade a login for one that cannot see the valve, such as a scan from the wrong Smart Life account.
    const probe = new TuyaClient(session, { fetch: this.opts.fetch, now: this.opts.now });
    await probe.deviceStatus(this.env.TUYA_DEVICE_ID);
    await this.storage.put(SESSION_KEY, probe.getSession()); // after the call: it may have refreshed the tokens
    await this.storage.delete(PENDING_QR_KEY);
    this.client = undefined;
    return { state: "done" };
  }

  private now = () => (this.opts.now ?? Date.now)();

  async status(): Promise<ValveStatus> {
    const { online, status } = await (await this.tuya()).deviceStatus(this.env.TUYA_DEVICE_ID);
    return {
      online,
      open: status[this.switchCode] === true,
      batteryPct: typeof status.battery_percentage === "number" ? status.battery_percentage : undefined,
      countdownSeconds: this.countdownCode && typeof status[this.countdownCode] === "number" ? (status[this.countdownCode] as number) : undefined,
    };
  }

  /** Open the valve for `seconds` (plus a margin the valve enforces itself) and confirm it reports open. */
  async open(seconds: number): Promise<void> {
    const commands: { code: string; value: unknown }[] = [{ code: this.switchCode, value: true }];
    if (this.countdownCode) commands.push({ code: this.countdownCode, value: Math.round(seconds) + FAILSAFE_MARGIN_SECONDS });
    await (await this.tuya()).sendCommands(this.env.TUYA_DEVICE_ID, commands);
    await this.confirm(true);
  }

  async close(): Promise<void> {
    await (await this.tuya()).sendCommands(this.env.TUYA_DEVICE_ID, [{ code: this.switchCode, value: false }]);
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

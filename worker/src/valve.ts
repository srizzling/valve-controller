import type { Env } from "./env";
import { sessionFromSeed, TuyaClient } from "./tuya";
import type { TuyaSession } from "./tuya";

const SESSION_KEY = "tuya:session";

// The valve closes itself this long after it was meant to, if the Worker never sends the close. It is the
// failsafe the homelab agent's timer used to be. It only applies when the valve has a countdown function.
const FAILSAFE_MARGIN_SECONDS = 90;

export interface ValveStatus {
  online: boolean;
  open: boolean;
  batteryPct?: number;
  countdownSeconds?: number;
}

export interface ValveOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The garden valve, reached through Tuya's cloud. */
export class Valve {
  private client?: TuyaClient;

  constructor(private storage: DurableObjectStorage, private env: Env, private opts: ValveOptions = {}) {}

  private get switchCode() {
    return this.env.TUYA_SWITCH_CODE || "switch_1";
  }

  private get countdownCode() {
    return this.env.TUYA_COUNTDOWN_CODE ?? "countdown_1"; // set it to an empty string for a valve without one
  }

  private async tuya(): Promise<TuyaClient> {
    if (this.client) return this.client;
    const saved = await this.storage.get<TuyaSession>(SESSION_KEY);
    const seed = this.env.TUYA_SESSION ? sessionFromSeed(this.env.TUYA_SESSION) : undefined;
    // The saved session has the newest rotating tokens, so it wins, unless a later login was deployed.
    const session = saved && (!seed || saved.loginAt >= seed.loginAt) ? saved : seed;
    if (!session) throw new Error("No Tuya login is configured. Run scripts/tuya-login.py, then apply Terraform.");
    if (session !== saved) await this.storage.put(SESSION_KEY, session);
    this.client = new TuyaClient(session, {
      fetch: this.opts.fetch,
      now: this.opts.now,
      onSession: (s) => this.storage.put(SESSION_KEY, s),
    });
    return this.client;
  }

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

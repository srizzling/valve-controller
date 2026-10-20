import { DurableObject } from "cloudflare:workers";
import { closeValve, openValve } from "./agent";
import type { Env } from "./env";
import { notify } from "./ntfy";
import { advance, defaultConfig, dueSchedule, idleState, startRun, wateredSoFar } from "./plan";
import type { Config, RunState, Trigger } from "./plan";
import { fetchForecast, rainVerdict } from "./rain";

export interface HistoryEntry {
  at: number;
  trigger: Trigger;
  outcome: "completed" | "stopped" | "skipped-rain" | "error";
  wateredSeconds: number;
  note: string;
}

export interface Status {
  state: RunState;
  config: Config;
  now: number;
  history: HistoryEntry[];
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;
const HISTORY_LIMIT = 20;

const mins = (seconds: number) => `${Math.round((seconds / 60) * 10) / 10} min`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Controller extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  // Storage is consistent, but awaiting a network call lets other requests interleave.
  // Run every state-changing operation one at a time.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async getState(): Promise<RunState> {
    return (await this.ctx.storage.get<RunState>("state")) ?? idleState;
  }

  async getConfig(): Promise<Config> {
    return (await this.ctx.storage.get<Config>("config")) ?? defaultConfig;
  }

  async setConfig(config: Config): Promise<Config> {
    await this.ctx.storage.put("config", config);
    return config;
  }

  async getStatus(): Promise<Status> {
    const history = (await this.ctx.storage.get<HistoryEntry[]>("history")) ?? [];
    return { state: await this.getState(), config: await this.getConfig(), now: Date.now(), history };
  }

  start(trigger: Trigger): Promise<{ ok: boolean; message: string }> {
    return this.serial(() => this.doStart(trigger));
  }

  stop(): Promise<{ ok: boolean; message: string }> {
    return this.serial(async () => {
      const state = await this.getState();
      const now = Date.now();
      let note = "stopped by request";
      let ok = true;
      try {
        await closeValve(this.env);
      } catch (e) {
        ok = false;
        note = `stop requested but the valve did not confirm closing (${message(e)}); the agent keeps retrying`;
        await notify(this.env, { title: "Valve: stop failed", message: note, tags: ["rotating_light"], priority: 5 });
      }
      if (state.phase !== "idle") {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.put("state", idleState);
        const watered = wateredSoFar(state, now);
        await this.record({ at: state.startedAt, trigger: state.trigger, outcome: "stopped", wateredSeconds: watered, note });
        if (ok) await notify(this.env, { title: "Valve: stopped", message: `Stopped after ${mins(watered)} of watering.`, tags: ["octagonal_sign"] });
      }
      return { ok, message: note };
    });
  }

  /** Called every minute by the cron trigger. */
  tick(): Promise<void> {
    return this.serial(async () => {
      const state = await this.getState();
      const now = Date.now();
      if (state.phase !== "idle") {
        // self-heal if the alarm was lost
        if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Math.max(now, state.phaseEndsAt));
        return;
      }
      const key = dueSchedule(await this.getConfig(), now, this.env.TIMEZONE);
      if (!key || (await this.ctx.storage.get("lastScheduleKey")) === key) return;
      await this.ctx.storage.put("lastScheduleKey", key);
      await this.doStart("schedule");
    });
  }

  async alarm(): Promise<void> {
    await this.serial(async () => {
      const state = await this.getState();
      if (state.phase === "idle") return;
      const now = Date.now();
      const step = advance(state, now);
      try {
        if (step.valve === "close") await closeValve(this.env);
        else if (step.valve === "open") await openValve(this.env, step.next.onSeconds);
      } catch (e) {
        const attempts = state.attempts + 1;
        if (attempts < MAX_ATTEMPTS) {
          await this.ctx.storage.put("state", { ...state, attempts });
          await this.ctx.storage.setAlarm(now + RETRY_DELAY_MS);
          return;
        }
        await this.abort(state, `gave up after ${attempts} failed attempts: ${message(e)}`);
        return;
      }
      if (step.finished) {
        await this.ctx.storage.put("state", idleState);
        const watered = step.next.wateredSeconds;
        await this.record({ at: state.startedAt, trigger: state.trigger, outcome: "completed", wateredSeconds: watered, note: `${state.cycles} cycles` });
        await notify(this.env, { title: "Valve: finished", message: `Watered ${mins(watered)} over ${state.cycles} cycles.`, tags: ["white_check_mark"] });
        return;
      }
      await this.ctx.storage.put("state", step.next);
      await this.ctx.storage.setAlarm(step.next.phaseEndsAt);
    });
  }

  private async doStart(trigger: Trigger): Promise<{ ok: boolean; message: string }> {
    if ((await this.getState()).phase !== "idle") return { ok: false, message: "already running" };
    const config = await this.getConfig();
    const now = Date.now();
    let rainNote = "";

    // Only scheduled runs respect the rain check; starting by hand or by voice is deliberate.
    if (trigger === "schedule" && config.rain.enabled) {
      try {
        const verdict = rainVerdict(await fetchForecast(this.env.LATITUDE, this.env.LONGITUDE), config.rain, now);
        if (verdict.skip) {
          await this.record({ at: now, trigger, outcome: "skipped-rain", wateredSeconds: 0, note: verdict.reason });
          await notify(this.env, { title: "Valve: skipped for rain", message: `Scheduled run skipped. ${verdict.reason}.`, tags: ["cloud_with_rain"] });
          return { ok: true, message: `skipped: ${verdict.reason}` };
        }
        rainNote = ` Forecast: ${verdict.reason}.`;
      } catch (e) {
        rainNote = ` Rain check failed (${message(e)}), watering anyway.`;
      }
    }

    const run = startRun(config, trigger, now);
    try {
      await openValve(this.env, run.onSeconds);
    } catch (e) {
      await closeValve(this.env).catch(() => undefined);
      const note = `could not open the valve: ${message(e)}`;
      await this.record({ at: now, trigger, outcome: "error", wateredSeconds: 0, note });
      await notify(this.env, { title: "Valve: failed to start", message: note, tags: ["rotating_light"], priority: 5 });
      return { ok: false, message: note };
    }
    await this.ctx.storage.put("state", run);
    await this.ctx.storage.setAlarm(run.phaseEndsAt);
    const plan = `${run.cycles} x ${mins(run.onSeconds)} on, ${mins(run.soakSeconds)} soak between.`;
    await notify(this.env, { title: "Valve: started", message: `${trigger} run. ${plan}${rainNote}`, tags: ["droplet"] });
    return { ok: true, message: `started: ${plan}` };
  }

  private async abort(state: RunState, note: string): Promise<void> {
    await closeValve(this.env).catch(() => undefined);
    await this.ctx.storage.put("state", idleState);
    await this.record({ at: state.startedAt, trigger: state.trigger, outcome: "error", wateredSeconds: wateredSoFar(state, Date.now()), note });
    await notify(this.env, { title: "Valve: run aborted", message: note, tags: ["rotating_light"], priority: 5 });
  }

  private async record(entry: HistoryEntry): Promise<void> {
    const history = (await this.ctx.storage.get<HistoryEntry[]>("history")) ?? [];
    await this.ctx.storage.put("history", [entry, ...history].slice(0, HISTORY_LIMIT));
  }
}

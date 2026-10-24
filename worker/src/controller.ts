import { DurableObject } from "cloudflare:workers";
import { catchUpStep, newCatchUp } from "./catchup";
import type { CatchUp } from "./catchup";
import type { Env } from "./env";
import { ping } from "./heartbeat";
import type { Signal } from "./heartbeat";
import { notify } from "./ntfy";
import { advance, dueEntry, dueSchedule, defaultConfig, idleState, nextRunAt, normalizeConfig, startRun, wateredSoFar } from "./plan";
import type { Config, RunState, Trigger } from "./plan";
import { placeOf } from "./place";
import { rainVerdict } from "./rain";
import type { Forecast } from "./rain";
import { extraRunWanted, inputsAt, smartPlan } from "./smart";
import { MAX_OPEN_MS, MAX_RUN_MS, runOverdue, watchOpen } from "./supervisor";
import { TuyaAuthError } from "./tuya";
import { getWeather } from "./weather";
import type { WeatherBundle } from "./weather";
import { Valve } from "./valve";
import type { Reconnect, ValveStatus } from "./valve";

export interface HistoryEntry {
  at: number;
  trigger: Trigger;
  outcome: "completed" | "stopped" | "skipped-rain" | "skipped-weather" | "error";
  wateredSeconds: number;
  note: string;
}

export interface Status {
  state: RunState;
  config: Config;
  now: number;
  timezone: string;
  nextRunAt: number | null;
  history: HistoryEntry[];
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;
const HISTORY_LIMIT = 20;
const PREFLIGHT_LEAD_MS = 10 * 60_000; // check the agent and valve this long before a scheduled start

const mins = (seconds: number) => `${Math.round((seconds / 60) * 10) / 10} min`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Controller extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private valve = new Valve(this.ctx.storage, this.env, {
    onLoginDead: ({ remaining, reason }) =>
      notify(
        this.env,
        remaining > 0
          ? { title: "Valve: a Tuya login stopped working", message: `${reason} The valve is still running on the other login. Add a backup from the UI (the 🔑 chip) before it goes too.`, tags: ["warning"], priority: 4 }
          : { title: "Valve: Tuya login expired", message: `${reason} No working login is left, so runs will fail until you reconnect from the UI (the 🔑 chip).`, tags: ["rotating_light"], priority: 5 },
      ),
  });

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
    const saved = await this.ctx.storage.get<Config>("config");
    return saved ? normalizeConfig(saved) : defaultConfig;
  }

  async setConfig(config: Config): Promise<Config> {
    await this.ctx.storage.put("config", config);
    return config;
  }

  /** The forecast, kept in storage so a restarted Worker does not have to ask Open-Meteo again. */
  weather(now = Date.now()): Promise<WeatherBundle> {
    return getWeather(this.env, now, fetch, this.ctx.storage);
  }

  async getStatus(): Promise<Status> {
    const [history, config, state] = await Promise.all([this.ctx.storage.get<HistoryEntry[]>("history"), this.getConfig(), this.getState()]);
    const now = Date.now();
    return { state, config, now, timezone: this.env.TIMEZONE, nextRunAt: nextRunAt(config, now, placeOf(this.env)), history: history ?? [] };
  }

  /** Errors do not keep their class across a Durable Object call, so say here whether the login is the problem. */
  async getValve(): Promise<ValveStatus | { error: string; loginExpired: boolean }> {
    try {
      return await this.valve.status();
    } catch (e) {
      return { error: message(e), loginExpired: e instanceof TuyaAuthError };
    }
  }

  reconnectStart(): Promise<Reconnect> {
    return this.serial(() => this.valve.reconnectStart());
  }

  reconnectCheck(): Promise<Reconnect> {
    return this.serial(() => this.valve.reconnectCheck());
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
        await this.valve.close();
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
        await this.heartbeat(state.trigger, "ok", note); // stopped on purpose, so not a missing run
      }
      return { ok, message: note };
    });
  }

  /** Called every minute by the cron trigger. */
  tick(): Promise<void> {
    return this.serial(async () => {
      await this.valve.keepWarm().catch(() => undefined); // keeps the spare login alive; a failure shows up in the checks below
      await this.supervise();
      const state = await this.getState();
      const now = Date.now();
      if (state.phase !== "idle") {
        // self-heal if the alarm was lost
        if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Math.max(now, state.phaseEndsAt));
        return;
      }
      const config = await this.getConfig();
      const upcoming = dueSchedule(config, now + PREFLIGHT_LEAD_MS, placeOf(this.env));
      if (upcoming && (await this.ctx.storage.get("lastPreflightKey")) !== upcoming) {
        await this.ctx.storage.put("lastPreflightKey", upcoming);
        await this.preflight(upcoming.slice(-5));
      }
      const due = dueEntry(config, now, placeOf(this.env));
      if (due && (await this.ctx.storage.get("lastScheduleKey")) !== due.key) {
        await this.ctx.storage.put("lastScheduleKey", due.key);
        await this.doStart("schedule", due.entry.onlyIfEtMm);
        return;
      }
      await this.catchUp(config, now);
    });
  }

  /** A run skipped for rain: once the rain was due, water if it did not come. */
  private async catchUp(config: Config, now: number): Promise<void> {
    const pending = await this.ctx.storage.get<CatchUp>("catchUp");
    if (!pending) return;
    let forecast: Forecast | undefined;
    if (config.enabled && now >= pending.checkAt && now < pending.expiresAt) forecast = (await this.weather(now).catch(() => undefined))?.forecast;
    const step = config.enabled ? catchUpStep(pending, forecast, config.rain, placeOf(this.env), now) : ({ do: "drop" } as const);
    if (step.do === "wait") return;
    await this.ctx.storage.delete("catchUp");
    if (step.do === "run") await this.doStart("catch-up", undefined, step.note);
  }

  async alarm(): Promise<void> {
    await this.serial(async () => {
      const state = await this.getState();
      if (state.phase === "idle") return;
      const now = Date.now();
      const step = advance(state, now);

      // Is the valve where the plan says it is? Someone using the Smart Life app mid-run would change it, and a valve
      // left open when it should be soaking is the one thing we must not carry on from.
      const expectedOpen = state.phase === "watering";
      try {
        const actual = await this.valve.status();
        if (actual.open !== expectedOpen) {
          await this.abort(state, `The valve was ${actual.open ? "opened" : "closed"} outside the controller while it should have been ${expectedOpen ? "watering" : "soaking"}. Run stopped.`);
          return;
        }
      } catch {
        // can't tell right now; the step below will report a real failure if Tuya really is unreachable
      }

      try {
        if (step.valve === "close") await this.valve.close();
        else if (step.valve === "open") await this.valve.open(step.next.onSeconds);
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
        const summary = `Watered ${mins(watered)} over ${state.cycles} cycles.`;
        await notify(this.env, { title: "Valve: finished", message: summary, tags: ["white_check_mark"] });
        await this.heartbeat(state.trigger, "ok", summary);
        return;
      }
      await this.ctx.storage.put("state", step.next);
      await this.ctx.storage.setAlarm(step.next.phaseEndsAt);
    });
  }

  /** `extraRunEtMm`: set for a start time that is an extra run, which only goes ahead when today's ET is at least that. */
  private async doStart(trigger: Trigger, extraRunEtMm?: number, catchUpNote?: string): Promise<{ ok: boolean; message: string }> {
    if ((await this.getState()).phase !== "idle") return { ok: false, message: "already running" };
    const config = await this.getConfig();
    const now = Date.now();
    let rainNote = "";
    let cycles = config.cycles;
    let scaling = "";

    // Only scheduled runs (and their make-up) use the forecast; starting by hand or by voice is deliberate and runs exactly what you set.
    if (trigger === "schedule" || trigger === "catch-up") {
      let weather: WeatherBundle | undefined;
      let weatherProblem = "";
      try {
        weather = await this.weather(now);
      } catch (e) {
        weatherProblem = message(e);
      }
      if (extraRunEtMm !== undefined) {
        // An extra run is only wanted on a hot day. Not wanted, or no way to tell, means nothing happens: no record, no alert.
        const want = weather ? extraRunWanted(extraRunEtMm, inputsAt(weather.forecast, now, this.env.TIMEZONE).etMm) : "unknown";
        if (want !== "yes") return { ok: true, message: `extra run not needed (${want === "no" ? `ET is below ${extraRunEtMm} mm` : "no ET forecast"})` };
      }
      if (!weather) {
        rainNote = ` Weather check failed (${weatherProblem}), so your normal cycles apply.`;
      } else {
        if (catchUpNote) rainNote = ` ${catchUpNote}`; // the rain check was made just before this
        if (trigger === "schedule" && config.rain.enabled) {
          try {
            const verdict = rainVerdict(weather.forecast, config.rain, now);
            if (verdict.skip) {
              await this.record({ at: now, trigger, outcome: "skipped-rain", wateredSeconds: 0, note: verdict.reason });
              const pending = extraRunEtMm === undefined && config.rain.catchUp ? newCatchUp(now, config.rain, nextRunAt(config, now, placeOf(this.env))) : null;
              if (pending) await this.ctx.storage.put("catchUp", pending);
              const later = pending ? ` After ${this.clock(pending.checkAt)} it checks whether the rain came and waters if not.` : "";
              await notify(this.env, { title: "Valve: skipped for rain", message: `Scheduled run skipped. ${verdict.reason}.${later}`, tags: ["cloud_with_rain"] });
              await this.heartbeat(trigger, "ok", `skipped for rain: ${verdict.reason}`);
              return { ok: true, message: `skipped: ${verdict.reason}` };
            }
            rainNote = ` Forecast: ${verdict.reason}.`;
          } catch (e) {
            rainNote = ` Rain check failed (${message(e)}), watering anyway.`;
          }
        }
        const smart = smartPlan(config.smart, config.cycles, inputsAt(weather.forecast, now, this.env.TIMEZONE));
        if (!smart.run) {
          const why = smart.reasons.join(" ");
          await this.record({ at: now, trigger, outcome: "skipped-weather", wateredSeconds: 0, note: why });
          await notify(this.env, { title: "Valve: skipped for the weather", message: `${trigger === "schedule" ? "Scheduled" : "Catch-up"} run skipped. ${why}`, tags: ["warning"] });
          await this.heartbeat(trigger, "ok", `skipped for the weather: ${why}`);
          return { ok: true, message: `skipped: ${why}` };
        }
        cycles = smart.cycles;
        scaling = smart.reasons.length ? ` ${smart.reasons.join(" ")}` : "";
      }
    }

    const run = startRun(config, trigger, now, cycles);
    try {
      await this.valve.open(run.onSeconds);
    } catch (e) {
      await this.valve.close().catch(() => undefined);
      const note = `could not open the valve: ${message(e)}`;
      await this.record({ at: now, trigger, outcome: "error", wateredSeconds: 0, note });
      await notify(this.env, { title: "Valve: failed to start", message: note, tags: ["rotating_light"], priority: 5 });
      await this.heartbeat(trigger, "fail", note);
      return { ok: false, message: note };
    }
    await this.ctx.storage.put("state", run);
    await this.ctx.storage.setAlarm(run.phaseEndsAt);
    await this.ctx.storage.delete("catchUp"); // this run is the make-up for any rain skip still waiting
    const plan = `${run.cycles} x ${mins(run.onSeconds)} on, ${mins(run.soakSeconds)} soak between.`;
    await notify(this.env, { title: "Valve: started", message: `${trigger} run. ${plan}${rainNote}${scaling}`, tags: ["droplet"] });
    await this.heartbeat(trigger, "start", plan);
    return { ok: true, message: `started: ${plan}` };
  }

  private clock(at: number): string {
    return new Intl.DateTimeFormat("en-AU", { timeZone: this.env.TIMEZONE, hour: "numeric", minute: "2-digit" }).format(new Date(at));
  }

  private async abort(state: RunState, note: string): Promise<void> {
    await this.valve.close().catch(() => undefined);
    await this.ctx.storage.put("state", idleState);
    await this.record({ at: state.startedAt, trigger: state.trigger, outcome: "error", wateredSeconds: wateredSoFar(state, Date.now()), note });
    await notify(this.env, { title: "Valve: run aborted", message: note, tags: ["rotating_light"], priority: 5 });
    await this.heartbeat(state.trigger, "fail", note);
  }

  /**
   * Independent of the plan, two hour-long limits: the valve open for over an hour (left on in the Smart Life app, or a
   * close that never happened), or a run, soaks included, going for over an hour. Either way close the valve, end the
   * run and shout. It watches the real valve and the clock, not the plan.
   */
  private async supervise(): Promise<void> {
    let open: boolean | undefined;
    try {
      open = (await this.valve.status()).open;
    } catch {
      // can't tell right now; the run limit below still applies and the open limit is tried again next minute
    }
    const now = Date.now();
    const before = (await this.ctx.storage.get<number>("openSince")) ?? null;
    const watch = open === undefined ? { openSince: before, overdue: false } : watchOpen(before, open, now);
    if (watch.openSince !== before) {
      if (watch.openSince === null) await this.ctx.storage.delete("openSince");
      else await this.ctx.storage.put("openSince", watch.openSince);
    }

    const state = await this.getState();
    let note: string;
    if (watch.overdue && watch.openSince !== null) {
      note = `The valve had been open for ${mins((now - watch.openSince) / 1000)}, over the ${mins(MAX_OPEN_MS / 1000)} limit. Closed it.`;
    } else if (state.phase !== "idle" && runOverdue(state.startedAt, now)) {
      note = `The run had been going for ${mins((now - state.startedAt) / 1000)}, over the ${mins(MAX_RUN_MS / 1000)} limit. Stopped it and closed the valve.`;
    } else {
      return;
    }

    try {
      await this.valve.close();
    } catch (e) {
      await notify(this.env, { title: "Valve: could not force-close", message: `${note} But the close failed (${message(e)}). Retrying every minute.`, tags: ["rotating_light"], priority: 5 });
      return;
    }
    await this.ctx.storage.delete("openSince");
    if (state.phase !== "idle") {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.put("state", idleState);
      await this.record({ at: state.startedAt, trigger: state.trigger, outcome: "error", wateredSeconds: wateredSoFar(state, now), note });
      await this.heartbeat(state.trigger, "fail", note);
    } else {
      await this.record({ at: now, trigger: "manual", outcome: "error", wateredSeconds: 0, note });
    }
    await notify(this.env, { title: "Valve: force-closed", message: note, tags: ["rotating_light"], priority: 5 });
  }

  /** Only scheduled runs report to healthchecks.io: it exists to notice a schedule that stopped firing. */
  private async heartbeat(trigger: Trigger, signal: Signal, body: string): Promise<void> {
    if (trigger === "schedule") await ping(this.env, signal, body);
  }

  /** Shortly before a scheduled start: can we reach the valve, is it online, and is it unexpectedly open? */
  private async preflight(at: string): Promise<void> {
    try {
      const status = await this.valve.status();
      if (status.open) {
        await notify(this.env, { title: "Valve: open while idle", message: `The valve is open but no run is active (next run ${at}). Something left it on.`, tags: ["rotating_light"], priority: 5 });
      } else if (!status.online) {
        await notify(this.env, { title: "Valve: offline", message: `The ${at} run is 10 minutes away but Tuya reports the valve offline. Check its Wi-Fi and batteries.`, tags: ["warning"], priority: 4 });
      } else if (status.batteryPct !== undefined && status.batteryPct <= 20) {
        await notify(this.env, { title: "Valve: low battery", message: `The valve battery is at ${status.batteryPct}%.`, tags: ["battery"], priority: 3 });
      }
    } catch (e) {
      const expired = e instanceof TuyaAuthError;
      await notify(this.env, {
        title: expired ? "Valve: Tuya login expired" : "Valve: cannot reach the valve",
        message: expired ? `${message(e)} The ${at} run will fail until you do.` : `The ${at} run is 10 minutes away but Tuya's cloud did not answer: ${message(e)}`,
        tags: ["warning"],
        priority: expired ? 5 : 4,
      });
    }
  }

  private async record(entry: HistoryEntry): Promise<void> {
    const history = (await this.ctx.storage.get<HistoryEntry[]>("history")) ?? [];
    await this.ctx.storage.put("history", [entry, ...history].slice(0, HISTORY_LIMIT));
  }
}

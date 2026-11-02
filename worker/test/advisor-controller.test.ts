import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/plan";
import type { Config } from "../src/plan";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));
const { Controller } = await import("../src/controller");

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string | string[]) => (Array.isArray(k) ? new Map(k.map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k: string | Record<string, unknown>, v?: unknown) => void (typeof k === "string" ? m.set(k, v) : Object.entries(k).forEach(([a, b]) => m.set(a, b))),
    delete: async (k: string | string[]) => void [k].flat().forEach((x) => m.delete(x)),
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    m,
  };
}

const TZ = "Australia/Melbourne";
const PLANNED = defaultConfig.cycles; // a typical dry day scales to 100% of this
const MAX = Math.ceil((PLANNED * defaultConfig.smart.maxPercent) / 100); // "never above"
const plural = (n: number) => `${n} cycle${n === 1 ? "" : "s"}`;
const hostOf = (url: string) => new URL(url).host;
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer;
const baseEnv = { TIMEZONE: TZ, LATITUDE: "-37.81", LONGITUDE: "144.96", NTFY_URL: "https://ntfy.test", NTFY_TOPIC: "t", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://claude.test" };
const localDate = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const localClock = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

/** A forecast for a typical dry day: the plan comes out at 100%, which is the configured cycles. */
function weatherBundle(now: number, over: { tempC?: number; rainy?: boolean; soil?: number } = {}) {
  const hour = Math.floor(now / 3_600_000) * 3_600_000;
  const times = [-2, -1, 0, 1, 2, 3].map((h) => new Date(hour + h * 3_600_000).toISOString().slice(0, 13) + ":00");
  const fill = <T,>(v: T) => times.map(() => v);
  return {
    data: {
      current: { temperatureC: 24, humidityPct: 40, windKmh: 8, condition: { label: "Sunny" } },
      etTodayMm: 4.5,
      soilMoisture: 0.15,
      past24hMm: 0,
      next24hMm: 0,
      rainChanceNext24hPct: 5,
    },
    forecast: {
      time: times,
      precipitation_probability: fill(over.rainy ? 90 : 0),
      precipitation: fill(0),
      temperatureC: fill(over.tempC ?? 20),
      windKmh: fill(8),
      soilMoistureShallow: fill(over.soil ?? 0.15),
      soilMoistureDeep: fill(over.soil ?? 0.15),
      etByDate: { [localDate(now)]: 4.5 },
    },
  };
}

function make(decision: object | null | "down", opts: { config?: Partial<Config>; env?: object; tempC?: number; rainy?: boolean; soil?: number } = {}) {
  const storage = fakeStorage();
  const calls: { url: string; method?: string; headers: Headers; body?: any }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" && hostOf(url) === "claude.test" ? JSON.parse(init.body) : init.body; // Claude takes JSON; ntfy takes the message text
    calls.push({ url, method: init.method, headers: new Headers(init.headers), body });
    if (hostOf(url) === "claude.test") return decision === "down" ? new Response("busy", { status: 529 }) : Response.json({ content: [{ type: "tool_use", name: "decide", input: decision }] });
    return new Response("ok");
  });
  const c = new Controller({ storage } as never, { ...baseEnv, ...opts.env } as never);
  const valve = { open: vi.fn(async () => {}), close: vi.fn(async () => {}), status: vi.fn(async () => ({ online: true, open: false })) };
  (c as any).valve = valve;
  (c as any).weather = async (now: number) => weatherBundle(now, { tempC: opts.tempC, rainy: opts.rainy, soil: opts.soil });
  const config: Config = { ...defaultConfig, rain: { ...defaultConfig.rain, enabled: false }, ai: { enabled: true }, ...opts.config };
  const ready = storage.put("config", config);
  return {
    c,
    storage,
    valve,
    calls,
    claude: () => calls.filter((x) => hostOf(x.url) === "claude.test"),
    ntfy: () => calls.filter((x) => hostOf(x.url) === "ntfy.test"),
    start: async () => (await ready, c.start("schedule")),
    history: () => storage.m.get("history") as { outcome: string; note: string }[],
    state: () => storage.m.get("state") as { cycles: number } | undefined,
    catchUp: () => storage.m.get("catchUp"),
    freshPhoto: async (ageMs = 60_000) => {
      await storage.put("cam:precheck", { at: Date.now() - ageMs });
      await storage.put("cam:precheck:img", jpeg);
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("asking Claude before a scheduled run", () => {
  it("waters the number of cycles Claude chose, and says why", async () => {
    const t = make({ cycles: MAX, reason: "Pots look dry and it is hot." });
    await t.freshPhoto();
    expect((await t.start()).ok).toBe(true);
    expect(t.state()?.cycles).toBe(MAX);
    const started = t.ntfy().find((n) => n.headers.get("title") === "Valve: started");
    expect(started?.body).toContain(`Claude: Pots look dry and it is hot. (${plural(MAX)} instead of ${PLANNED})`);
    const [image, prompt] = t.claude()[0].body.messages[0].content;
    expect(image.type).toBe("image");
    expect(prompt.text).toContain("taken 1 min ago, just before this run");
    expect(t.claude()[0].body.tools[0].input_schema.properties.cycles.maximum).toBe(MAX); // from "never above"
  });

  it("skips the run when Claude says to, records it, and sends the photo", async () => {
    const t = make({ cycles: 0, reason: "Soil is dark and damp." });
    await t.freshPhoto();
    const r = await t.start();
    expect(r.message).toContain("skipped: Claude: Soil is dark and damp.");
    expect(t.valve.open).not.toHaveBeenCalled();
    expect(t.state()).toBeUndefined();
    expect(t.history()[0]).toMatchObject({ outcome: "skipped-weather", note: "Claude: Soil is dark and damp." });
    const alert = t.ntfy().find((n) => n.headers.get("title") === "Valve: skipped by Claude");
    expect(alert?.method).toBe("PUT"); // the photo is attached
  });

  it("keeps the planned cycles when Claude agrees", async () => {
    const t = make({ cycles: PLANNED, reason: "Looks right." });
    await t.freshPhoto();
    await t.start();
    expect(t.state()?.cycles).toBe(PLANNED);
    expect(t.ntfy().find((n) => n.headers.get("title") === "Valve: started")?.body).toContain("Claude: Looks right.");
    expect(t.ntfy().find((n) => n.headers.get("title") === "Valve: started")?.body).not.toContain("instead of");
  });

  it("waters as planned, and says so, when Claude cannot be reached", async () => {
    const t = make("down");
    await t.freshPhoto();
    expect((await t.start()).ok).toBe(true);
    expect(t.state()?.cycles).toBe(PLANNED);
    expect(t.ntfy().find((n) => n.headers.get("title") === "Valve: started")?.body).toMatch(new RegExp(`Claude check failed \\(the model answered 529\\), so the planned ${plural(PLANNED)} apply`));
  });

  it("waters as planned when Claude's answer is not a decision", async () => {
    const t = make({ cycles: "lots" });
    await t.freshPhoto();
    await t.start();
    expect(t.state()?.cycles).toBe(PLANNED);
    expect(t.ntfy().find((n) => n.headers.get("title") === "Valve: started")?.body).toContain("Claude check failed");
  });

  it("falls back to today's daily photo when no fresh frame arrived, and tells the model how old it is", async () => {
    const t = make({ cycles: PLANNED, reason: "ok" });
    const today = localDate(Date.now());
    await t.storage.put("cam:days", [{ date: today, plant: "Mint is bushy" }]);
    await t.storage.put(`cam:img:${today}`, jpeg);
    await t.start();
    const prompt = t.claude()[0].body.messages[0].content[1].text;
    expect(prompt).toContain(`the daily photo from ${today}`);
    expect(prompt).toContain("Mint is bushy");
  });

  it("does not use a pre-run frame from an earlier run", async () => {
    const t = make({ cycles: PLANNED, reason: "ok" });
    await t.freshPhoto(2 * 3600_000);
    await t.start();
    expect(t.claude()).toHaveLength(0);
    expect(t.state()?.cycles).toBe(PLANNED);
    expect(t.ntfy().find((n) => n.headers.get("title") === "Valve: started")?.body).toContain("No recent photo for the Claude check");
  });

  it("is not asked when the setting is off, or for a run started by hand", async () => {
    const off = make({ cycles: 0, reason: "x" }, { config: { ai: { enabled: false } } });
    await off.freshPhoto();
    await off.start();
    expect(off.claude()).toHaveLength(0);
    expect(off.state()?.cycles).toBe(PLANNED);

    const manual = make({ cycles: 0, reason: "x" });
    await manual.freshPhoto();
    await manual.storage.put("config", { ...defaultConfig, ai: { enabled: true } });
    await manual.c.start("manual");
    expect(manual.claude()).toHaveLength(0);
    expect(manual.state()?.cycles).toBe(PLANNED);
  });

  it("cannot water through a weather gate: a frost skip never reaches Claude", async () => {
    const t = make({ cycles: MAX, reason: "Water it!" }, { tempC: -3 });
    await t.freshPhoto();
    const r = await t.start();
    expect(r.message).toMatch(/skipped: Frost risk/);
    expect(t.claude()).toHaveLength(0);
    expect(t.state()).toBeUndefined();
  });

  it("says so when the check is on but there is no key", async () => {
    const t = make({ cycles: 0, reason: "x" }, { env: { ANTHROPIC_API_KEY: undefined } });
    await t.start();
    expect(t.state()?.cycles).toBe(PLANNED);
    expect(t.ntfy().find((n) => n.headers.get("title") === "Valve: started")?.body).toContain("no ANTHROPIC_API_KEY");
  });
});

describe("the pre-run frame", () => {
  const soon = (minutes: number) => ({ ...defaultConfig, ai: { enabled: true }, schedules: [{ days: [0, 1, 2, 3, 4, 5, 6], at: "clock" as const, time: localClock(Date.now() + minutes * 60_000) }] });

  it("is asked for once, shortly before a scheduled start, and not when the start is far off", async () => {
    const t = make({ cycles: PLANNED, reason: "ok" }, { config: soon(4) });
    await t.storage.put("cam:marks", { timelapseDate: localDate(Date.now()) }); // today's daily frame is already done
    await t.storage.put("config", soon(4));
    expect(await t.c.cameraWanted()).toBe("precheck");
    await t.c.cameraFrame("precheck", jpeg);
    expect(await t.c.cameraWanted()).toBeNull();

    await t.storage.put("config", soon(40));
    await t.storage.put("cam:marks", { timelapseDate: localDate(Date.now()), precheckDone: "" });
    expect(await t.c.cameraWanted()).toBeNull();
  });

  it("is not asked for when the check is off or there is no key", async () => {
    const off = make({ cycles: PLANNED, reason: "ok" });
    await off.storage.put("cam:marks", { timelapseDate: localDate(Date.now()) });
    await off.storage.put("config", { ...soon(4), ai: { enabled: false } });
    expect(await off.c.cameraWanted()).toBeNull();

    const noKey = make({ cycles: PLANNED, reason: "ok" }, { env: { ANTHROPIC_API_KEY: undefined } });
    await noKey.storage.put("cam:marks", { timelapseDate: localDate(Date.now()) });
    await noKey.storage.put("config", soon(4));
    expect(await noKey.c.cameraWanted()).toBeNull();
  });

  it("is kept for the decision, not looked at on arrival, and does not replace the latest photo", async () => {
    const t = make({ cycles: PLANNED, reason: "ok" });
    await t.storage.put("config", soon(4));
    const meta = await t.c.cameraFrame("precheck", jpeg);
    expect(meta.verdict).toBeUndefined();
    expect(t.claude()).toHaveLength(0); // no leak check on this one
    expect((await t.c.cameraOverview()).latest).toBeNull();
    expect(t.storage.m.get("cam:precheck:img")).toEqual(jpeg);
  });
});

describe("Claude reviewing a skip", () => {
  const rain = { rain: { ...defaultConfig.rain, enabled: true } };
  const started = (t: ReturnType<typeof make>) => t.ntfy().find((n) => n.headers.get("title") === "Valve: started")?.body as string;

  it("overrules a rain skip when the pots are dry, up to the normal number of cycles, and sets no catch-up", async () => {
    const t = make({ cycles: 1, reason: "The pots under the eave are bone dry." }, { rainy: true, config: rain });
    await t.freshPhoto();
    expect((await t.start()).ok).toBe(true);
    expect(t.state()?.cycles).toBe(1);
    expect(t.catchUp()).toBeUndefined();
    expect(started(t)).toContain("The checks said to skip (rain likely");
    expect(started(t)).toContain("Claude: The pots under the eave are bone dry. (1 cycle instead of skipping)");
    expect(t.claude()[0].body.messages[0].content[1].text).toContain("would SKIP this run");
    expect(t.claude()[0].body.tools[0].input_schema.properties.cycles.maximum).toBe(defaultConfig.cycles); // not above normal when overruling a skip
  });

  it("keeps a rain skip when Claude agrees, and says why in the record, the alert and the catch-up", async () => {
    const t = make({ cycles: 0, reason: "Soil is dark and damp." }, { rainy: true, config: rain });
    await t.freshPhoto();
    const r = await t.start();
    expect(r.message).toContain("skipped: rain likely");
    expect(t.valve.open).not.toHaveBeenCalled();
    expect(t.history()[0].outcome).toBe("skipped-rain");
    expect(t.history()[0].note).toMatch(/rain likely.*Claude: Soil is dark and damp\./);
    expect(t.ntfy().find((n) => n.headers.get("title") === "Valve: skipped for rain")?.body).toContain("Claude: Soil is dark and damp.");
    expect(t.catchUp()).toBeDefined(); // the make-up check still happens
  });

  it("keeps the rain skip when Claude cannot be reached or there is no photo", async () => {
    const down = make("down", { rainy: true, config: rain });
    await down.freshPhoto();
    await down.start();
    expect(down.history()[0]).toMatchObject({ outcome: "skipped-rain" });
    expect(down.history()[0].note).toContain("Claude check failed (the model answered 529), so the skip stands.");
    expect(down.valve.open).not.toHaveBeenCalled();

    const noPhoto = make({ cycles: 2, reason: "x" }, { rainy: true, config: rain });
    await noPhoto.start();
    expect(noPhoto.claude()).toHaveLength(0);
    expect(noPhoto.history()[0].note).toContain("No recent photo for the Claude check, so the skip stands.");
  });

  it("overrules a wet-soil skip, and keeps one it agrees with", async () => {
    const over = make({ cycles: 2, reason: "The soil in these pots is dry on top and the leaves droop." }, { soil: 0.45 });
    await over.freshPhoto();
    await over.start();
    expect(over.state()?.cycles).toBe(2);
    expect(started(over)).toContain("The checks said to skip (Soil is wet");

    const agree = make({ cycles: 0, reason: "Soil is damp." }, { soil: 0.45 });
    await agree.freshPhoto();
    await agree.start();
    expect(agree.valve.open).not.toHaveBeenCalled();
    expect(agree.history()[0]).toMatchObject({ outcome: "skipped-weather" });
    expect(agree.history()[0].note).toMatch(/Soil is wet.*Claude: Soil is damp\./);
  });

  it("cannot be talked above the normal number of cycles when overruling a skip", async () => {
    const t = make({ cycles: 20, reason: "Very dry." }, { soil: 0.45 });
    await t.freshPhoto();
    await t.start();
    expect(t.state()?.cycles).toBe(defaultConfig.cycles);
  });

  it("never reviews a frost or wind stop, even with a rain skip beside it", async () => {
    const frost = make({ cycles: 2, reason: "Water it!" }, { tempC: -3, rainy: true, config: rain });
    await frost.freshPhoto();
    await frost.start();
    expect(frost.claude()).toHaveLength(0);
    expect(frost.valve.open).not.toHaveBeenCalled();
    expect(frost.history()[0].outcome).toBe("skipped-rain"); // as before the Claude check existed

    const wind = make({ cycles: 2, reason: "Water it!" }, { soil: 0.45, config: { smart: { ...defaultConfig.smart, wind: { enabled: true, maxKmh: 5 } } } });
    await wind.freshPhoto();
    await wind.start();
    expect(wind.claude()).toHaveLength(0);
    expect(wind.history()[0].note).toMatch(/Too windy/);
  });

  it("leaves skips exactly as they were when the Claude check is off", async () => {
    const t = make({ cycles: 2, reason: "x" }, { rainy: true, config: { ...rain, ai: { enabled: false } } });
    await t.freshPhoto();
    await t.start();
    expect(t.claude()).toHaveLength(0);
    expect(t.history()[0].note).toMatch(/^rain likely: 90% chance, 0\.0 mm in the next 6h$/);
    expect(t.ntfy().find((n) => n.headers.get("title") === "Valve: skipped for rain")?.body).toMatch(/^Scheduled run skipped\. rain likely: .*in the next 6h\. After /);
  });
});

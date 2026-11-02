import { describe, expect, it } from "vitest";
import { systemFor, AFTER_DELAY_MS, AFTER_WINDOW_MS, DURING_DELAY_MS, MANUAL_WINDOW_MS, POLL_STALE_MS, scriptStale, askVision, duringKey, isJpeg, noMarks, parsePots, parseVerdict, toBase64, wantedFrame } from "../src/camera";
import { idleState, startRun, defaultConfig } from "../src/plan";

const TZ = "Australia/Melbourne";
// 2026-11-02 03:00 UTC is 14:00 in Melbourne (UTC+11)
const afternoon = Date.UTC(2026, 10, 2, 3, 0);
const morning = Date.UTC(2026, 10, 1, 20, 0); // 07:00 local
const watering = startRun({ ...defaultConfig, onMinutes: 5 }, "manual", afternoon);
const base = { timeZone: TZ, timelapseHour: 12 };

describe("wantedFrame", () => {
  it("wants nothing while idle with nothing due", () => {
    expect(wantedFrame({ ...base, now: morning, state: idleState, marks: noMarks })).toBeNull();
  });

  it("waits for the water to reach the emitters, then asks once per watering period", () => {
    const at = (ms: number) => wantedFrame({ ...base, now: watering.phaseStartedAt + ms, state: watering, marks: { ...noMarks, timelapseDate: "2026-11-02" } });
    expect(at(DURING_DELAY_MS - 1)).toBeNull();
    expect(at(DURING_DELAY_MS)).toBe("during");
    const done = { ...noMarks, timelapseDate: "2026-11-02", duringDone: duringKey(watering) };
    expect(wantedFrame({ ...base, now: watering.phaseStartedAt + DURING_DELAY_MS, state: watering, marks: done })).toBeNull();
    expect(wantedFrame({ ...base, now: watering.phaseStartedAt + DURING_DELAY_MS, state: { ...watering, cycle: 2 }, marks: done })).toBe("during");
  });

  it("does not ask for a leak check in the last seconds of a watering period", () => {
    expect(wantedFrame({ ...base, now: watering.phaseEndsAt - 2_000, state: watering, marks: { ...noMarks, timelapseDate: "2026-11-02" } })).toBeNull();
  });

  it("asks for a frame after a run ends, inside a window", () => {
    const marks = { ...noMarks, timelapseDate: "2026-11-02", afterDue: { key: "1", at: afternoon + AFTER_DELAY_MS } };
    const at = (ms: number) => wantedFrame({ ...base, now: afternoon + ms, state: idleState, marks });
    expect(at(AFTER_DELAY_MS - 1)).toBeNull();
    expect(at(AFTER_DELAY_MS)).toBe("after");
    expect(at(AFTER_DELAY_MS + AFTER_WINDOW_MS)).toBeNull();
  });

  it("answers a photo request from the UI first, until it goes stale", () => {
    const marks = { ...noMarks, manualAt: afternoon };
    expect(wantedFrame({ ...base, now: afternoon + 1000, state: watering, marks })).toBe("manual");
    expect(wantedFrame({ ...base, now: afternoon + MANUAL_WINDOW_MS, state: idleState, marks: { ...marks, timelapseDate: "2026-11-02" } })).toBeNull();
  });

  it("wants the daily frame once, after the chosen hour and before sunset", () => {
    const sunset = afternoon + 5 * 3_600_000;
    expect(wantedFrame({ ...base, now: afternoon, state: idleState, marks: noMarks, daylightEnds: sunset })).toBe("timelapse");
    expect(wantedFrame({ ...base, now: morning, state: idleState, marks: noMarks, daylightEnds: sunset })).toBeNull();
    expect(wantedFrame({ ...base, now: afternoon, state: idleState, marks: { ...noMarks, timelapseDate: "2026-11-02" }, daylightEnds: sunset })).toBeNull();
    expect(wantedFrame({ ...base, now: sunset + 1, state: idleState, marks: noMarks, daylightEnds: sunset })).toBeNull();
  });
});

describe("frames", () => {
  it("recognises a JPEG by its first bytes", () => {
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe(true);
    expect(isJpeg(new TextEncoder().encode("<html>"))).toBe(false);
    expect(isJpeg(new Uint8Array())).toBe(false);
  });

  it("encodes bytes bigger than one chunk", () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => i % 251);
    expect(Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0))).toEqual(bytes);
  });
});

const reply = (input: object) => ({ content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "report", input }] });

describe("parseVerdict", () => {
  it("reads the report", () => {
    expect(parseVerdict(reply({ leak: true, summary: "Hose has come off", plant: "Upright and green" }))).toEqual({ leak: true, summary: "Hose has come off", plant: "Upright and green" });
  });
  it("leaves out an empty plant note", () => {
    expect(parseVerdict(reply({ leak: false, summary: "Fine", plant: " " }))).toEqual({ leak: false, summary: "Fine" });
  });
  it("treats anything unexpected as an error, never as no leak", () => {
    expect(() => parseVerdict({ content: [{ type: "text", text: "no leak" }] })).toThrow();
    expect(() => parseVerdict(reply({ summary: "x" }))).toThrow();
    expect(() => parseVerdict(null)).toThrow();
  });
});

describe("systemFor", () => {
  it("adds what the camera looks at, trimmed and capped", () => {
    expect(systemFor("  a lemon tree and mint in pots ")).toContain("In this garden: a lemon tree and mint in pots");
    expect(systemFor("x".repeat(1000)).length).toBeLessThan(systemFor().length + 450);
  });
  it("is just the base prompt when nothing is said", () => {
    expect(systemFor("   ")).toBe(systemFor());
    expect(systemFor()).not.toContain("In this garden");
  });
});

describe("askVision", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const env = { ANTHROPIC_API_KEY: "key", ANTHROPIC_BASE_URL: "https://fake.test", CAMERA_SCENE: "lemon tree and two roses in pots" } as never;

  it("sends the frame with the key and returns the verdict", async () => {
    let seen: { url: string; headers: Headers; body: any } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) };
      return Response.json(reply({ leak: false, summary: "Dry and quiet" }));
    }) as never;
    expect(await askVision(env, "during", true, jpeg, fake)).toEqual({ leak: false, summary: "Dry and quiet" });
    expect(seen?.url).toBe("https://fake.test/v1/messages");
    expect(seen?.headers.get("x-api-key")).toBe("key");
    expect(seen?.body.model).toBe("claude-haiku-5-5");
    expect(seen?.body.tool_choice).toEqual({ type: "tool", name: "report" });
    expect(seen?.body.messages[0].content[0].source.data).toBe(toBase64(jpeg));
    expect(seen?.body.messages[0].content[1].text).toContain("valve opened");
    expect(seen?.body.system).toContain("lemon tree and two roses in pots");
  });

  it("says so when there is no key or the model errors", async () => {
    await expect(askVision({} as never, "manual", false, jpeg)).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(askVision(env, "manual", false, jpeg, (async () => new Response("no", { status: 529 })) as never)).rejects.toThrow(/529/);
  });
});

describe("scriptStale", () => {
  it("is not a fault until the script has been seen once", () => {
    expect(scriptStale(null, 10 * POLL_STALE_MS)).toBe(false);
  });
  it("is a fault once it has been quiet for longer than the limit", () => {
    expect(scriptStale(1000, 1000 + POLL_STALE_MS)).toBe(false);
    expect(scriptStale(1000, 1001 + POLL_STALE_MS)).toBe(true);
  });
});

const POTS = JSON.stringify([
  { name: "Mint", where: "small black pot, right", box: [0.32, 0.4, 0.07, 0.12] },
  { name: "Lemon tree", where: "big black pot, centre", box: [0.25, 0.36, 0.1, 0.2] },
]);

describe("parsePots", () => {
  it("reads the list", () => {
    expect(parsePots(POTS)).toEqual([
      { name: "Mint", where: "small black pot, right", box: [0.32, 0.4, 0.07, 0.12] },
      { name: "Lemon tree", where: "big black pot, centre", box: [0.25, 0.36, 0.1, 0.2] },
    ]);
  });
  it("is empty when nothing is set or it is not JSON, so a typo cannot take the Worker down", () => {
    expect(parsePots(undefined)).toEqual([]);
    expect(parsePots("  ")).toEqual([]);
    expect(parsePots("{not json")).toEqual([]);
    expect(parsePots('{"name":"Mint"}')).toEqual([]);
  });
  it("drops a pot with no name, a repeated name, or a box that is not inside the frame", () => {
    const bad = JSON.stringify([
      { name: "", box: [0, 0, 0.1, 0.1] },
      { name: "Mint", box: [0, 0, 0.1, 0.1] },
      { name: "mint", box: [0.5, 0.5, 0.1, 0.1] },
      { name: "Wide", box: [0.5, 0, 0.6, 0.1] },
      { name: "Flat", box: [0, 0, 0.1, 0] },
      { name: "Short", box: [0, 0, 0.1] },
      { name: "Text", box: ["0", 0, 0.1, 0.1] },
      null,
    ]);
    expect(parsePots(bad).map((p) => p.name)).toEqual(["Mint"]);
  });
});

describe("pots in the model call", () => {
  const pots = parsePots(POTS);
  it("tells the model how to tell the pots apart", () => {
    expect(systemFor("scene", pots)).toContain("Mint (small black pot, right); Lemon tree (big black pot, centre)");
    expect(systemFor("scene")).not.toContain("The pots");
  });
  it("keeps only notes for pots we listed, once each, spelled our way", () => {
    const v = parseVerdict(reply({ leak: false, summary: "Fine", pots: [{ pot: "mint", note: " Bushy " }, { pot: "Mint", note: "again" }, { pot: "Cactus", note: "invented" }, { pot: "Lemon tree", note: " " }] }), pots);
    expect(v.pots).toEqual([{ pot: "Mint", note: "Bushy" }]);
  });
  it("has no pots in the verdict when none are configured", () => {
    expect(parseVerdict(reply({ leak: false, summary: "Fine", pots: [{ pot: "Mint", note: "x" }] }))).toEqual({ leak: false, summary: "Fine" });
  });

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const env = { ANTHROPIC_API_KEY: "key", ANTHROPIC_BASE_URL: "https://fake.test", CAMERA_POTS: POTS } as never;
  const sent = async (kind: "during" | "timelapse" | "manual") => {
    let body: any;
    const fake = (async (_u: string, init: RequestInit) => ((body = JSON.parse(init.body as string)), Response.json(reply({ leak: false, summary: "Fine", pots: [{ pot: "Mint", note: "Bushy" }] })))) as never;
    const verdict = await askVision(env, kind, false, jpeg, fake);
    return { body, verdict };
  };

  it("asks for a note per pot on the daily photo and a photo you asked for", async () => {
    for (const kind of ["timelapse", "manual"] as const) {
      const { body, verdict } = await sent(kind);
      expect(body.tools[0].input_schema.properties.pots.items.properties.pot.enum).toEqual(["Mint", "Lemon tree"]);
      expect(body.system).toContain("small black pot, right");
      expect(verdict.pots).toEqual([{ pot: "Mint", note: "Bushy" }]);
    }
  });
  it("leaves the pots out of a leak check", async () => {
    const { body, verdict } = await sent("during");
    expect(body.tools[0].input_schema.properties.pots).toBeUndefined();
    expect(verdict.pots).toBeUndefined();
  });
});

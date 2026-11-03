import { describe, expect, it } from "vitest";
import { askWatering, describeSituation, parseAdvice } from "../src/advisor";
import type { AdviceInput } from "../src/advisor";
import { toBase64 } from "../src/camera";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const input: AdviceInput = {
  jpeg,
  photoNote: "taken 2 min ago, just before this run",
  now: Date.UTC(2026, 10, 2, 19, 30), // 06:30 Tuesday in Melbourne
  timeZone: "Australia/Melbourne",
  weather: {
    current: { temperatureC: 18.4, humidityPct: 61, windKmh: 9, condition: { label: "Mostly sunny" } },
    etTodayMm: 5.2,
    soilMoisture: 0.17,
    past24hMm: 0,
    next24hMm: 0.4,
    rainChanceNext24hPct: 20,
  } as never,
  planned: { cycles: 3, base: 3, max: 5, why: "Typical day (ET 4.5 mm, 100% of normal), soil dry (0.17). That is 100% of normal." },
  onMinutes: 10,
  soakMinutes: 5,
  history: [{ at: Date.UTC(2026, 10, 2, 8, 0), trigger: "schedule", outcome: "completed", wateredSeconds: 1800, note: "" }],
  plants: "Mint: bushy. Over the past days: the lemon tree has new leaves.",
};

describe("parseAdvice", () => {
  const reply = (i: object) => ({ content: [{ type: "tool_use", name: "decide", input: i }] });

  it("reads the cycles and the reason", () => {
    expect(parseAdvice(reply({ cycles: 4, reason: "Soil looks dry." }), 5)).toEqual({ cycles: 4, reason: "Soil looks dry." });
  });
  it("keeps the cycles inside 0 and the maximum, whatever the model says", () => {
    expect(parseAdvice(reply({ cycles: 99, reason: "x" }), 5).cycles).toBe(5);
    expect(parseAdvice(reply({ cycles: -2, reason: "x" }), 5).cycles).toBe(0);
    expect(parseAdvice(reply({ cycles: 2.6, reason: "x" }), 5).cycles).toBe(3);
  });
  it("refuses anything that is not a decision, so it never reads as 'water as planned'", () => {
    expect(() => parseAdvice({ content: [{ type: "text", text: "water it" }] }, 5)).toThrow(/decision/);
    expect(() => parseAdvice(reply({ cycles: "3", reason: "x" }), 5)).toThrow(/decision/);
    expect(() => parseAdvice(reply({ cycles: 3, reason: "  " }), 5)).toThrow(/decision/);
    expect(() => parseAdvice(null, 5)).toThrow(/decision/);
  });
});

describe("describeSituation", () => {
  const text = describeSituation(input);
  it("gives the photo's age, the plan and the limits", () => {
    expect(text).toContain("taken 2 min ago, just before this run");
    expect(text).toContain("Planned: 3 cycles of 10 min on and 5 min soak");
    expect(text).toContain("the most you may choose is 5");
  });
  it("gives the weather, the soil and the last watering", () => {
    expect(text).toContain("18.4°C");
    expect(text).toContain("evapotranspiration today 5.2 mm");
    expect(text).toContain("soil moisture 0.17 m³/m³");
    expect(text).toContain("0.4 mm expected");
    expect(text).toContain("completed, 30 min");
  });
  it("passes on what the camera said about the plants", () => {
    expect(text).toContain("the lemon tree has new leaves");
  });
  it("copes with no weather and no history", () => {
    const bare = describeSituation({ ...input, weather: undefined, history: [], plants: undefined });
    expect(bare).toContain("Weather: not available.");
    expect(bare).toContain("Recent runs: none recorded.");
  });
});

describe("askWatering", () => {
  const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://claude.test", CAMERA_SCENE: "Six pots on a deck." } as never;
  const answer = (cycles: number) => (async () => Response.json({ content: [{ type: "tool_use", name: "decide", input: { cycles, reason: "Dry soil." } }] })) as unknown as typeof fetch;

  it("sends the photo and the situation, and bounds the tool by the maximum", async () => {
    let sent: any;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) };
      return Response.json({ content: [{ type: "tool_use", name: "decide", input: { cycles: 4, reason: "Dry soil." } }] });
    }) as unknown as typeof fetch;
    expect(await askWatering(env, input, fetchImpl)).toEqual({ cycles: 4, reason: "Dry soil." });
    expect(sent.url).toBe("https://claude.test/v1/messages");
    expect(sent.headers.get("x-api-key")).toBe("k");
    expect(sent.body.model).toBe("claude-haiku-5-5");
    expect(sent.body.tool_choice).toEqual({ type: "tool", name: "decide" });
    expect(sent.body.tools[0].input_schema.properties.cycles.maximum).toBe(5);
    expect(sent.body.system).toContain("Six pots on a deck.");
    const [image, prompt] = sent.body.messages[0].content;
    expect(image.source.data).toBe(toBase64(jpeg));
    expect(prompt.text).toContain("Planned: 3 cycles");
  });
  it("uses the model the camera is set to use", async () => {
    let model = "";
    await askWatering({ ...(env as object), CAMERA_MODEL: "claude-sonnet-5-5" } as never, input, (async (_u: string, init: RequestInit) => {
      model = JSON.parse(init.body as string).model;
      return Response.json({ content: [{ type: "tool_use", name: "decide", input: { cycles: 3, reason: "ok" } }] });
    }) as unknown as typeof fetch);
    expect(model).toBe("claude-sonnet-5-5");
  });
  it("clamps a reply above the maximum", async () => {
    expect((await askWatering(env, input, answer(12))).cycles).toBe(5);
  });
  it("throws when there is no key or the model is unavailable", async () => {
    await expect(askWatering({} as never, input, answer(3))).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(askWatering(env, input, (async () => new Response("busy", { status: 529 })) as unknown as typeof fetch)).rejects.toThrow(/529/);
  });
});

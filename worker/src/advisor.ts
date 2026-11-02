// "Is it worth watering?": a Claude model looks at a garden photo next to the numbers the schedule already has.
//
// It never sees a frost or wind stop, so it cannot water through one. When the schedule would skip for rain, wet soil or low
// demand it can confirm the skip or overrule it (up to your normal cycles); when the run is going ahead it can lower the
// cycle count, skip, or raise it up to `max`, which the caller sets from your "never above" percentage.
import type { HistoryEntry } from "./controller";
import { toBase64 } from "./camera";
import type { Env } from "./env";
import type { WeatherData } from "./weather";

export interface Advice {
  cycles: number; // 0 means skip this run
  reason: string;
}

export interface AdviceInput {
  jpeg: Uint8Array;
  photoNote: string; // when the photo was taken and what kind it is, so the model can weigh how old it is
  now: number;
  timeZone: string;
  weather?: WeatherData;
  planned: { cycles: number; base: number; max: number; why: string }; // cycles of 0 means the schedule would skip, and `why` is the reason
  onMinutes: number;
  soakMinutes: number;
  history: HistoryEntry[];
  plants?: string; // the latest per-plant notes and growth summary
}

const TOOL_NAME = "decide";
const HISTORY_SHOWN = 6;

const SYSTEM =
  "You help decide whether a small garden of potted plants, watered by a timed drip valve, needs water at the start of a " +
  "scheduled run. The schedule has already applied its frost and wind limits, and worked out from the forecast either a number " +
  "of cycles or a decision to skip. You can keep that, lower the number, raise it up to the stated maximum, or choose 0 to skip. " +
  "A skip for rain, wet soil or low demand comes from a regional weather model, not from these pots: a pot under cover, or one that " +
  "drains fast, can be dry whatever the model says. Confirm such a skip unless the photo clearly shows dry soil or stressed plants. " +
  "Judge from the photo first: how dark and damp the soil looks, wilting, drooping or curled leaves, dry crusted soil, standing " +
  "water. Then use the numbers: heat, how much the garden loses in a day, soil moisture, rain in the last day and expected, " +
  "and when it was last watered. Raise the number only for plants that clearly look dry or stressed. Skip only when the soil is " +
  "clearly wet or the plants clearly do not need it. The photo may be dark or infrared at dawn and dusk, and a pot can be hidden; " +
  "when you cannot judge, keep the planned number and say so. Be brief and concrete.";

const toolFor = (max: number) => ({
  name: TOOL_NAME,
  description: "Say how many cycles to water.",
  input_schema: {
    type: "object",
    properties: {
      cycles: { type: "integer", minimum: 0, maximum: max, description: `Cycles to run, from 0 (skip the run) to ${max}.` },
      reason: { type: "string", description: "One or two short sentences on why, naming what you saw and what the numbers say." },
    },
    required: ["cycles", "reason"],
  },
});

const clock = (at: number, timeZone: string) => new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short", hour: "numeric", minute: "2-digit", hour12: false }).format(new Date(at));
const num = (n: number | undefined, unit: string, digits = 1) => (typeof n === "number" ? `${Math.round(n * 10 ** digits) / 10 ** digits}${unit}` : "unknown");

/** The numbers and history that go next to the photo. Exported so a test can read what the model is told. */
export function describeSituation(i: AdviceInput): string {
  const w = i.weather;
  const lines = [
    `Now: ${clock(i.now, i.timeZone)}. Photo: ${i.photoNote}`,
    i.planned.cycles === 0
      ? `Planned: the schedule would SKIP this run. Its reason: ${i.planned.why}\nChoose 0 to confirm the skip, or 1 to ${i.planned.max} cycles of ${i.onMinutes} min on and ${i.soakMinutes} min soak if the photo shows the plants need water (your normal is ${i.planned.base}).`
      : `Planned: ${i.planned.cycles} cycles of ${i.onMinutes} min on and ${i.soakMinutes} min soak (your normal is ${i.planned.base}; the most you may choose is ${i.planned.max}). The schedule's reasoning: ${i.planned.why || "no scaling applied"}`,
  ];
  if (w) {
    lines.push(
      `Weather now: ${num(w.current.temperatureC, "°C")}, ${num(w.current.humidityPct, "% humidity", 0)}, wind ${num(w.current.windKmh, " km/h", 0)}, ${w.current.condition.label}.`,
      `Garden water balance: evapotranspiration today ${num(w.etTodayMm, " mm")}, soil moisture ${num(w.soilMoisture, " m³/m³", 2)} (modelled; about 0.2 is dry and 0.4 is wet).`,
      `Rain: ${num(w.past24hMm, " mm")} in the last 24 hours, ${num(w.next24hMm, " mm")} expected in the next 24 hours (${num(w.rainChanceNext24hPct, "% chance", 0)}).`,
    );
  } else lines.push("Weather: not available.");
  const recent = i.history.slice(0, HISTORY_SHOWN).map((h) => `${clock(h.at, i.timeZone)}: ${h.outcome}${h.wateredSeconds ? `, ${Math.round(h.wateredSeconds / 60)} min` : ""}`);
  lines.push(recent.length ? `Recent runs, newest first: ${recent.join("; ")}.` : "Recent runs: none recorded.");
  if (i.plants) lines.push(`What the camera said about the plants earlier: ${i.plants}`);
  return lines.join("\n");
}

/** Reads the decision out of a Messages API reply. Anything unexpected is an error, never a quiet "water as planned". */
export function parseAdvice(reply: unknown, max: number): Advice {
  const content = (reply as { content?: { type: string; name?: string; input?: Record<string, unknown> }[] })?.content;
  const input = content?.find((c) => c.type === "tool_use" && c.name === TOOL_NAME)?.input;
  if (!input || typeof input.cycles !== "number" || !Number.isFinite(input.cycles) || typeof input.reason !== "string" || !input.reason.trim()) {
    throw new Error("the model did not return a decision");
  }
  return { cycles: Math.min(max, Math.max(0, Math.round(input.cycles))), reason: input.reason.trim().slice(0, 300) };
}

/** Ask a Claude model whether, and how much, to water. Throws when it cannot, so the caller can fall back to the planned cycles. */
export async function askWatering(env: Env, input: AdviceInput, fetchImpl: typeof fetch = fetch): Promise<Advice> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("no ANTHROPIC_API_KEY");
  const res = await fetchImpl(`${env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env.CAMERA_MODEL || "claude-haiku-5-5",
      max_tokens: 400,
      system: SYSTEM + (env.CAMERA_SCENE?.trim() ? ` In this garden: ${env.CAMERA_SCENE.trim().slice(0, 400)}` : ""),
      tools: [toolFor(input.planned.max)],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: toBase64(input.jpeg) } }, { type: "text", text: describeSituation(input) }] }],
    }),
    signal: AbortSignal.timeout(25_000), // the valve waits on this, so it must not hang
  });
  if (!res.ok) throw new Error(`the model answered ${res.status}`);
  return parseAdvice(await res.json(), input.planned.max);
}

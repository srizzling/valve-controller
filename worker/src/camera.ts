// The camera: what frame the Worker wants next, and what a vision model makes of one.
//
// Nothing here talks to the camera. A small script on your network (scripts/camera-pusher.mjs) asks
// /api/camera/wanted what to capture and posts the frame back, so the Worker decides when and the home side stays dumb.
import type { Env } from "./env";
import type { RunState } from "./plan";
import { localDate } from "./smart";

export type FrameKind =
  | "during" // shortly after the valve opens: is water going where it should?
  | "after" // a minute after a run ends: is anything still flowing?
  | "manual" // asked for from the UI
  | "timelapse"; // once a day, for the growth timelapse

export const FRAME_KINDS: readonly FrameKind[] = ["during", "after", "manual", "timelapse"];
export const isFrameKind = (s: unknown): s is FrameKind => FRAME_KINDS.includes(s as FrameKind);

export const DURING_DELAY_MS = 30_000; // water has reached the emitters and any fault is visible
export const AFTER_DELAY_MS = 60_000; // drips have stopped, a stuck-open valve has not
export const AFTER_WINDOW_MS = 5 * 60_000; // give up on an "after" frame if the camera never answers
export const MANUAL_WINDOW_MS = 5 * 60_000;
export const MAX_FRAME_BYTES = 1_500_000; // a Durable Object value is capped at 2 MB
export const DEFAULT_TIMELAPSE_HOUR = 12;
export const POLL_STALE_MS = 15 * 60_000; // the script asks every ~10 s, so this long without a question means it is down

/** Has the camera script, which was running, stopped asking? Never seen at all is not a fault: the camera is optional. */
export const scriptStale = (lastPollAt: number | null, now: number): boolean => lastPollAt !== null && now - lastPollAt > POLL_STALE_MS;

export interface Verdict {
  leak: boolean;
  summary: string; // one sentence on what the camera shows
  plant?: string; // one sentence on how the plants look
}

export interface FrameMeta {
  at: number;
  kind: FrameKind;
  valveOpen: boolean; // what the controller believed when the frame arrived
  verdict?: Verdict;
  error?: string; // why there is no verdict
}

export interface CameraMarks {
  duringDone: string; // `${startedAt}:${cycle}` of the last watering period that got its frame
  afterDue: { key: string; at: number } | null; // set when a run ends, cleared when its frame arrives
  timelapseDate: string; // local date of the last timelapse frame
  manualAt: number | null; // when the UI asked for a photo
  alerted: string; // the leak alert already sent, so one fault does not alert on every cycle
}

export const noMarks: CameraMarks = { duringDone: "", afterDue: null, timelapseDate: "", manualAt: null, alerted: "" };

export const duringKey = (s: RunState) => `${s.startedAt}:${s.cycle}`;

const localHour = (ts: number, timeZone: string) => Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(new Date(ts)));

/**
 * The frame to capture right now, or null. A leak check comes before the daily frame because it is time critical,
 * and a photo you asked for comes first because you are waiting for it.
 * `daylightEnds` stops the daily frame turning into an infrared shot when the camera was off all afternoon.
 */
export function wantedFrame(input: { now: number; state: RunState; marks: CameraMarks; timeZone: string; timelapseHour: number; daylightEnds?: number }): FrameKind | null {
  const { now, state, marks } = input;
  if (marks.manualAt !== null && now - marks.manualAt < MANUAL_WINDOW_MS) return "manual";
  if (state.phase === "watering" && duringKey(state) !== marks.duringDone && now >= state.phaseStartedAt + DURING_DELAY_MS && now < state.phaseEndsAt - 5_000) return "during";
  if (state.phase === "idle" && marks.afterDue && now >= marks.afterDue.at && now < marks.afterDue.at + AFTER_WINDOW_MS) return "after";
  if (localDate(now, input.timeZone) !== marks.timelapseDate && localHour(now, input.timeZone) >= input.timelapseHour && (input.daylightEnds === undefined || now < input.daylightEnds)) return "timelapse";
  return null;
}

/** Looks like a JPEG (SOI marker), so a stray upload cannot end up served back as an image. */
export const isJpeg = (b: Uint8Array) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const CONTEXT: Record<FrameKind, (open: boolean) => string> = {
  during: () => "The valve opened about 30 seconds ago, so water is expected where the hose or emitters are.",
  after: () => "The watering run finished about a minute ago and the valve is closed. Dripping and wet ground are normal; water still spraying or flowing is not.",
  manual: (open) => (open ? "The valve is open, so water is expected where the hose or emitters are." : "The valve is closed, so no water should be flowing."),
  timelapse: () => "This is the daily photo. The valve is closed, so no water should be flowing.",
};

const SYSTEM =
  "You watch a garden camera pointed at a drip irrigation valve and the potted plants it waters. Look for a fault: water " +
  "spraying or jetting from a place that is not a normal drip emitter or hose end, a hose or fitting that has come off or split, " +
  "water pooling or running across the ground, or water flowing when the valve should be shut. Damp soil, a wet pot and a little " +
  "water running from a pot's drain hole are normal. If the picture is dark, blocked or too unclear to judge, say so and report no leak. Be brief.";

/** The system prompt, with what the camera is looking at when the owner has said (CAMERA_SCENE). */
export const systemFor = (scene?: string) => (scene?.trim() ? `${SYSTEM} In this garden: ${scene.trim().slice(0, 400)}` : SYSTEM);

export function promptFor(kind: FrameKind, valveOpen: boolean): string {
  return `${CONTEXT[kind](valveOpen)} Report what the camera shows.`;
}

const TOOL = {
  name: "report",
  description: "Report what the garden camera shows.",
  input_schema: {
    type: "object",
    properties: {
      leak: { type: "boolean", description: "True only if there is a visible fault: water where it should not be, a detached or burst hose or fitting, or water flowing while the valve is shut." },
      summary: { type: "string", description: "One short sentence on what you see around the valve and hose." },
      plant: { type: "string", description: "One short sentence on how the plants look: new growth, colour, wilting or yellowing, naming the plant when something stands out. Leave out if no plant is visible." },
    },
    required: ["leak", "summary"],
  },
} as const;

/** Reads the tool call out of a Messages API reply. Anything unexpected is an error, never a quiet "no leak". */
export function parseVerdict(reply: unknown): Verdict {
  const content = (reply as { content?: { type: string; name?: string; input?: Record<string, unknown> }[] })?.content;
  const input = content?.find((c) => c.type === "tool_use" && c.name === TOOL.name)?.input;
  if (!input || typeof input.leak !== "boolean" || typeof input.summary !== "string") throw new Error("the model did not return a report");
  const verdict: Verdict = { leak: input.leak, summary: input.summary.slice(0, 300) };
  if (typeof input.plant === "string" && input.plant.trim()) verdict.plant = input.plant.slice(0, 300);
  return verdict;
}

/** Ask a Claude model to look at one frame. Throws when it cannot, so the caller can say the check did not happen. */
export async function askVision(env: Env, kind: FrameKind, valveOpen: boolean, jpeg: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<Verdict> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("no ANTHROPIC_API_KEY, so frames are kept but not checked");
  const res = await fetchImpl(`${env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env.CAMERA_MODEL || "claude-haiku-5-5",
      max_tokens: 300,
      system: systemFor(env.CAMERA_SCENE),
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: toBase64(jpeg) } }, { type: "text", text: promptFor(kind, valveOpen) }] }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`the vision model answered ${res.status}`);
  return parseVerdict(await res.json());
}

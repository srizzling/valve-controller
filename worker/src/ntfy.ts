import type { Env } from "./env";

export interface Notice {
  title: string; // ASCII only: it goes in an HTTP header
  message: string;
  tags?: string[]; // emoji shortcodes, e.g. "droplet"
  priority?: 1 | 2 | 3 | 4 | 5;
  image?: Uint8Array; // attached as a JPEG
}

/** Notifications are best effort: a failure here must never affect watering. */
export async function notify(env: Env, n: Notice): Promise<void> {
  try {
    const headers: Record<string, string> = { Title: n.title };
    if (n.tags?.length) headers.Tags = n.tags.join(",");
    if (n.priority) headers.Priority = String(n.priority);
    if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
    // ntfy takes an attachment as the request body, with the text in a header
    if (n.image) {
      headers.Message = n.message.replace(/[^\x20-\x7e]+/g, " "); // a header carries ASCII only
      headers.Filename = "valve.jpg";
    }
    const res = await fetch(`${env.NTFY_URL}/${env.NTFY_TOPIC}`, {
      method: n.image ? "PUT" : "POST", headers, body: n.image ?? n.message, signal: AbortSignal.timeout(n.image ? 20_000 : 10_000),
    });
    if (!res.ok) console.error(`ntfy returned ${res.status}`);
  } catch (e) {
    console.error("ntfy failed", e);
  }
}

#!/usr/bin/env node
// Runs on a machine on your home network that can reach the camera. The Worker decides when it wants a photo
// (while the valve waters, after a run, once a day, or when you press the button in the UI); this script asks every few
// seconds, takes one photo when asked, and posts it back. Plain Node, no packages.
//
//   node camera-pusher.mjs                 # keep running
//   node camera-pusher.mjs --once manual   # take one photo now and post it, to test the setup
//
// Settings, from the environment:
//   VALVE_URL                 https://valve.example.com (the Worker's address, the app_hostname in Terraform)
//   CF_ACCESS_CLIENT_ID       the Access service token: terraform output -raw camera_client_id
//   CF_ACCESS_CLIENT_SECRET   terraform output -raw camera_client_secret
//   CAMERA_SOURCE             where the photo comes from, one of:
//                               rtsp://user:pass@192.168.1.50/live   a stream; ffmpeg grabs one frame (needs ffmpeg)
//                               http://host/snapshot.jpg             an address that returns a JPEG
//                               cmd:<shell command>                  any command that prints a JPEG to stdout
//   POLL_SECONDS              how often to ask the Worker (default 10)
//   MAX_WIDTH                 shrink frames from an RTSP stream to this width (default 1280)
import { spawn } from "node:child_process";

const env = process.env;
const need = (k) => env[k] || (console.error(`${k} is not set`), process.exit(2));
const base = need("VALVE_URL").replace(/\/+$/, "");
const source = need("CAMERA_SOURCE");
const auth = { "CF-Access-Client-Id": need("CF_ACCESS_CLIENT_ID"), "CF-Access-Client-Secret": need("CF_ACCESS_CLIENT_SECRET") };
const pollMs = Math.max(2, Number(env.POLL_SECONDS) || 10) * 1000;
const width = Number(env.MAX_WIDTH) || 1280;
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

/** Run a program and collect its stdout. Gives up after `ms`. */
function run(cmd, args, ms = 30_000, shell = false) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell });
    const out = [];
    let err = "";
    const timer = setTimeout(() => (p.kill("SIGKILL"), reject(new Error(`${cmd} took over ${ms / 1000}s`))), ms);
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-500)));
    p.on("error", (e) => (clearTimeout(timer), reject(e)));
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exited ${code}: ${err.trim().split("\n").at(-1)}`));
    });
  });
}

async function grab() {
  if (source.startsWith("cmd:")) return run(source.slice(4), [], 30_000, true);
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`camera address answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return run("ffmpeg", ["-loglevel", "error", "-rtsp_transport", "tcp", "-i", source, "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "4", "-f", "image2pipe", "-vcodec", "mjpeg", "-"]);
}

async function call(path, init = {}) {
  const res = await fetch(`${base}/api${path}`, { ...init, headers: { ...auth, ...init.headers }, signal: AbortSignal.timeout(90_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${body.error ?? "no detail"}`);
  return body;
}

async function capture(kind) {
  const jpeg = await grab();
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("the camera source did not return a JPEG");
  const meta = await call(`/camera/frame?kind=${kind}`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: jpeg });
  log(`sent a ${kind} photo (${Math.round(jpeg.length / 1024)} kB): ${meta.verdict ? meta.verdict.summary : (meta.error ?? "kept")}${meta.verdict?.leak ? "  <- LEAK" : ""}`);
}

const once = process.argv.indexOf("--once");
if (once > 0) {
  await capture(process.argv[once + 1] ?? "manual").catch((e) => (console.error(e.message), process.exit(1)));
  process.exit(0);
}

log(`watching ${base}, taking photos from ${source.startsWith("cmd:") ? "a command" : source.replace(/\/\/[^@/]*@/, "//***@")}`);
let failures = 0;
for (;;) {
  try {
    const { capture: kind } = await call("/camera/wanted");
    if (kind) await capture(kind);
    failures = 0;
  } catch (e) {
    // a camera that is off or a Worker being deployed is normal; say so once and then every so often, not every poll
    if (failures++ % 30 === 0) log(`problem: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, pollMs));
}

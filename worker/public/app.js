const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const params = new URLSearchParams(location.search);
// ?demo=idle|watering|soaking|rain|delay|night|cloudy previews a scene with made-up data and no backend
const demo = params.get("demo");

let status = null;
let weather = null;
let valve = null; // {online, open, batteryPct} from Tuya, or {error}
let skew = 0; // server clock minus browser clock, so countdowns hold up with a wrong local clock
let schedules = [];
let busy = false;
let selectedDay = null;

/* ───────────────────────── scene construction ───────────────────────── */

const el = (name, attrs = {}, parent) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.append(node);
  return node;
};
// small deterministic pseudo-random so the garden looks the same on every load
const rand = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

function buildScene() {
  for (let i = 0; i < 12; i++) {
    const a = (i * 30 * Math.PI) / 180;
    el("line", { x1: Math.cos(a) * 36, y1: Math.sin(a) * 36, x2: Math.cos(a) * 50, y2: Math.sin(a) * 50 }, $("rays"));
  }
  for (let i = 0; i < 30; i++) {
    el("circle", { cx: rand() * 400, cy: rand() * 190, r: 0.8 + rand() * 1.4, style: `animation-delay:${-rand() * 3}s` }, $("stars"));
  }
  // petals: two staggered rings with a cartoon outline
  for (let i = 0; i < 14; i++) {
    el("ellipse", { cx: 200, cy: 66, rx: 10, ry: 25, fill: "#f6a700", stroke: "#cf7f00", "stroke-width": 1.6, transform: `rotate(${i * (360 / 14)} 200 105)` }, $("petalsBack"));
    el("ellipse", { cx: 200, cy: 68, rx: 9.5, ry: 22, fill: "#ffd62e", stroke: "#e89b00", "stroke-width": 1.6, transform: `rotate(${i * (360 / 14) + 360 / 28} 200 105)` }, $("petalsFront"));
  }
  // grass blades along the top of the soil
  const blades = $("blades");
  for (let x = -20; x < 430; x += 9) {
    const h = 9 + rand() * 11;
    const lean = (rand() - 0.5) * 8;
    el("path", { d: `M${x} 266 Q${x + lean / 2} ${266 - h * 0.6} ${x + lean} ${266 - h} Q${x + 4 + lean / 2} ${266 - h * 0.5} ${x + 6} 266Z`, fill: rand() > 0.5 ? "#6fcf4f" : "#57b640" }, blades);
  }
  // pebbles and sediment lines in the soil
  const soil = $("soilDetail");
  for (const y of [300, 340, 385, 425]) {
    el("path", { d: `M-20 ${y} Q 60 ${y - 8} 140 ${y + 2} T 300 ${y - 3} T 430 ${y + 4}`, stroke: "#ffffff", "stroke-opacity": 0.07, "stroke-width": 3, fill: "none" }, soil);
  }
  for (let i = 0; i < 26; i++) {
    el("ellipse", { cx: rand() * 400, cy: 282 + rand() * 150, rx: 2 + rand() * 4, ry: 1.6 + rand() * 3, fill: rand() > 0.5 ? "#8c6a4d" : "#33211a", opacity: 0.55 }, soil);
  }
  // spray from the hose nozzle: a fine fan of small droplets thrown out and down, with a faint mist where it leaves the nozzle
  el("path", { class: "mist", d: "M0 0 L-38 0 L-62 30 L-36 38Z", filter: "url(#softMist)" }, $("drops"));
  for (let i = 0; i < 44; i++) {
    const dx = -(26 + ((i * 11) % 52));
    const dur = 0.42 + (i % 5) * 0.04;
    const delay = -(i * 0.043);
    const fall = 88 + ((i * 7) % 20);
    const x = el("g", { class: "drop-x", style: `--dx:${dx}px;--dur:${dur}s;--delay:${delay}s` }, $("drops"));
    const y = el("g", { class: "drop-y spray", style: `--dur:${dur}s;--delay:${delay}s;--fall:${fall}px` }, x);
    el("circle", { r: 1.1 + (i % 3) * 0.35 }, y);
    if (i % 3 === 0) el("ellipse", { class: "splash", cx: 206 + dx, cy: 269, rx: 5, ry: 1.6, style: `--dur:${dur}s;--delay:${delay}s` }, $("splashes"));
  }
  // falling rain
  for (let i = 0; i < 34; i++) {
    const g = el("g", { transform: `translate(${(i * 13.7) % 430} 56)` }, $("streaks"));
    el("line", { class: "streak", x1: 0, y1: 0, x2: -3, y2: 13, style: `--dur:${0.65 + rand() * 0.45}s;--delay:${-rand() * 1.2}s` }, g);
  }
  for (let i = 0; i < 9; i++) {
    el("ellipse", { class: "rsplash", cx: 30 + i * 42 + rand() * 20, cy: 268, rx: 7, ry: 2, style: `--delay:${-rand() * 1.1}s` }, $("rainSplashes"));
  }
  // droplets creeping down through the soil towards the roots
  for (let i = 0; i < 16; i++) {
    const x = 120 + ((i * 37) % 170);
    el("ellipse", { cx: x, cy: 282, rx: 2.8, ry: 4.2, style: `--run:${70 + ((i * 23) % 80)}px;animation-delay:${-(i * 0.55)}s;animation-duration:${3.6 + (i % 5) * 0.5}s` }, $("seep"));
  }
}

/* ───────────────────────── formatting helpers ───────────────────────── */

const clock = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
const tz = () => status?.timezone;
const when = (ts) => new Intl.DateTimeFormat([], { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz() }).format(ts);
const nowMs = () => Date.now() + skew;
const mm = (n) => `${Number(n).toFixed(1)} mm`;
function relative(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h} h ${mins % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const minutesLabel = (m) => `${Math.round(m * 10) / 10} min`;
const cyclesLabel = (n) => `${n} cycle${n === 1 ? "" : "s"}`;

/* ───────────────────────── demo data ───────────────────────── */

function demoData(name) {
  const now = Date.now();
  const config = { enabled: true, onMinutes: 10, soakMinutes: 5, cycles: 3, schedules: [{ days: [0, 1, 2, 3, 4, 5, 6], at: "dawn", time: "00:00", beforeSunriseMin: 30 }, { days: [0, 1, 2, 3, 4, 5, 6], at: "dusk", time: "00:00", afterSunsetMin: -30 }, { days: [0, 1, 2, 3, 4, 5, 6], at: "clock", time: "15:00", onlyIfEtMm: 5.5 }], rain: { enabled: true, probabilityPct: 50, mm: 1, lookaheadHours: 6 },
    smart: { enabled: true, referenceEtMm: 4.5, cropFactor: 1, minPercent: 25, maxPercent: 150, soilDryBelow: 0.2, soilWetAbove: 0.35, wind: { enabled: true, maxKmh: 30 }, frost: { enabled: true, belowC: 2 } } };
  const idle = { phase: "idle", cycle: 0, cycles: 0, onSeconds: 0, soakSeconds: 0, phaseStartedAt: 0, phaseEndsAt: 0 };
  const running = (phase, left) => ({ phase, cycle: 2, cycles: 3, onSeconds: 600, soakSeconds: 300, phaseStartedAt: now - ((phase === "watering" ? 600 : 300) - left) * 1000, phaseEndsAt: now + left * 1000 });
  const state = name === "watering" ? running("watering", 372) : name === "soaking" ? running("soaking", 171) : idle;
  const cond = (label, kind, icon) => ({ label, kind, icon });
  const sunny = cond("Sunny", "clear", "☀️"), rainy = cond("Rain", "rain", "🌧️"), grey = cond("Overcast", "cloudy", "☁️");
  const c = name === "rain" || name === "delay" ? rainy : name === "cloudy" ? grey : sunny;
  const days = ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"];
  const rain = name === "rain" || name === "delay";
  const at = (i) => now + (i * 24 + 8) * 3600000;
  const run = (i, state, reason) => [{ at: at(i), state, reason }];
  const dry = "5% chance, 0.0 mm in the next 6h";
  const wet = "rain likely: 78% chance, 4.0 mm in the next 6h";
  const demoRuns = [
    () => rain ? run(0, "skip", wet) : [{ at: at(0), state: "will-run", reason: dry, cycles: 4, percent: 132, scaling: "Hot, dry day (ET 5.9 mm, 131% of normal), soil dry (0.18). That is 131% of normal: 4 cycles instead of 3." }, { at: at(0) + 6 * 3600000, state: "will-run", reason: dry, cycles: 4, percent: 131, scaling: "Hot, dry day (ET 5.9 mm, 131% of normal), soil dry (0.18). That is 131% of normal: 4 cycles instead of 3." }, { at: at(0) + 11 * 3600000, state: "will-run", reason: dry, cycles: 3, percent: 100, scaling: "Typical day (ET 4.5 mm, 100% of normal), soil dry (0.20). That is 100% of normal: 3 cycles, same as normal." }],
    () => rain ? run(1, "skip", wet) : [{ at: at(1), state: "will-run", reason: dry, cycles: 2, percent: 62, scaling: "Cool or humid day (ET 2.8 mm, 62% of normal), soil damp (0.27). That is 62% of normal: 2 cycles instead of 3." }],
    () => run(2, "skip", wet),
    () => [],
    () => [{ at: at(4), state: "skip-weather", reason: "Soil is wet (0.38 m³/m³), so no watering is needed. Weather: low (ET 1.9 mm)." }],
    () => run(5, "unknown", "the forecast does not reach this far yet"),
    () => [],
  ];
  return {
    status: { state, config, now, timezone: "Australia/Melbourne", nextRunAt: now + 8.2 * 3600000, history: [
      { at: now - 20 * 3600000, trigger: "schedule", outcome: "completed", wateredSeconds: 1800, note: "3 cycles" },
      { at: now - 44 * 3600000, trigger: "schedule", outcome: "skipped-rain", wateredSeconds: 0, note: "rain likely: 80% chance, 6.2 mm in the next 6h" },
    ] },
    weather: {
      fetchedAt: now,
      current: { temperatureC: rain ? 12.6 : 21.4, feelsLikeC: rain ? 10.8 : 20.1, humidityPct: rain ? 88 : 54, windKmh: rain ? 24 : 11, cloudCoverPct: rain ? 100 : 15, rainLastHourMm: rain ? 2.4 : 0, isDay: name !== "night", isRaining: name === "rain", condition: name === "night" ? cond("Clear", "clear", "🌙") : name === "delay" ? sunny : c },
      etTodayMm: rain ? 1.8 : 5.9, soilMoisture: rain ? 0.36 : 0.18,
      past24hMm: rain ? 8.4 : 0.6, next24hMm: rain ? 11.2 : 0.4, rainChanceNext24hPct: rain ? 85 : 20,
      daily: days.map((date, i) => ({ runs: demoRuns[i](date), date, condition: i === 1 && rain ? rainy : i === 3 ? grey : sunny, tMaxC: 22 - i, tMinC: 11 + (i % 3), rainMm: [0.4, rain ? 11.2 : 0.2, 3.1, 0, 0, 6.5, 1.2][i], chancePct: [20, rain ? 85 : 15, 55, 5, 0, 70, 30][i] })),
      nextRun: { at: now + 8.2 * 3600000, planned: rain ? undefined : { at: at(0), state: "will-run", reason: dry, cycles: 4, percent: 132, scaling: "Hot, dry day (ET 5.9 mm, 131% of normal), soil dry (0.18). That is 131% of normal: 4 cycles instead of 3." }, verdict: rain ? { skip: true, reason: "rain likely: 85% chance, 6.2 mm in the next 6h" } : { skip: false, reason: "20% chance, 0.2 mm in the next 6h" } },
    },
  };
}

/* ───────────────────────── rendering ───────────────────────── */

function sceneState() {
  const phase = status?.state.phase ?? "idle";
  const w = weather?.current;
  const raining = !!w?.isRaining;
  // the sky follows the real weather; a rain *forecast* alone never makes it rain.
  // Without weather data the sky stays overcast rather than claiming sun.
  const kind = w?.condition.kind ?? "cloudy";
  const sky = raining ? "rain" : kind === "clear" ? "clear" : kind === "partly" ? "partly" : "cloudy";
  return { phase, sky, night: w ? !w.isDay : false, raining };
}

function renderScene() {
  const { phase, sky, night, raining } = sceneState();
  const svg = $("scene");
  svg.dataset.valve = phase === "watering" ? "watering" : phase === "soaking" ? "soaking" : "idle";
  svg.dataset.sky = sky;
  svg.dataset.night = night ? "on" : "off";
  svg.dataset.rain = raining ? "on" : "off";
  svg.dataset.wet = phase === "watering" || raining ? "on" : "off";
  const words = { clear: night ? "a clear night" : "a sunny sky", partly: "a partly cloudy sky", cloudy: "an overcast sky", rain: "falling rain" };
  const asleep = night && svg.dataset.wet === "off";
  const what = phase === "watering" ? "being watered" : phase === "soaking" ? "while the water soaks in" : asleep ? "fast asleep" : "standing happily";
  svg.setAttribute("aria-label", `A cartoon sunflower ${what}, with ${words[sky]}`);
}

function renderTicking() {
  if (!status) return;
  const { state, config } = status;
  const now = nowMs();
  const panel = document.querySelector(".panel");
  const verdict = weather?.nextRun?.verdict;
  const delayed = !!verdict?.skip;
  const planned = weather?.nextRun?.planned;

  const pill = $("pill");
  const bar = $("bar");
  let big = "—", sub = "", mode = "idle", pillText = "Scheduled", pillClass = "pill-idle";
  const left = (state.phaseEndsAt - now) / 1000;
  const total = state.phase === "watering" ? state.onSeconds : state.soakSeconds;

  if (state.phase === "watering") {
    mode = "watering"; pillText = "Watering"; pillClass = "pill-watering";
    big = clock(left); sub = `Cycle ${state.cycle} of ${state.cycles} · ${state.cycle < state.cycles ? "then soak" : "last watering"}`;
  } else if (state.phase === "soaking") {
    mode = "soaking"; pillText = "Soaking"; pillClass = "pill-soaking";
    big = clock(left); sub = `Soaking in · watering again for cycle ${state.cycle + 1} of ${state.cycles}`;
  } else if (!config.enabled) {
    big = "Paused"; sub = "Scheduled runs are off. You can still water by hand."; pillText = "Paused";
  } else if (!status.nextRunAt) {
    big = "No start times"; sub = "Add one in Cycle & schedule.";
  } else {
    const nextAt = weather?.nextRun?.at ?? status.nextRunAt; // the weather view skips extra runs that are not needed
    big = when(nextAt);
    const scaled = planned?.state === "will-run" && planned.cycles;
    sub = `in ${relative(nextAt - now)} · ${cyclesLabel(scaled ? planned.cycles : config.cycles)} of ${minutesLabel(config.onMinutes)}, ${minutesLabel(config.soakMinutes)} soak between${scaled && planned.percent !== 100 ? ` (${planned.percent}% of normal)` : ""}`;
    if (delayed) { pillText = "Rain delay active"; pillClass = "pill-delay"; }
    else if (planned?.state === "skip-weather") { pillText = "Skipping: weather"; pillClass = "pill-delay"; }
    else if (weather?.current.isRaining) { pillText = "Raining"; pillClass = "pill-raining"; }
  }
  panel.dataset.mode = mode;
  pill.className = `pill ${pillClass}`;
  $("pill-text").textContent = pillText;
  $("big").textContent = big;
  $("sub").textContent = sub;

  const running = state.phase !== "idle";
  $("progress").hidden = !running;
  if (running) bar.style.width = `${Math.min(100, Math.max(0, ((total - left) / total) * 100))}%`;
  $("scene").style.setProperty("--soak", state.phase === "soaking" ? Math.min(1, Math.max(0, (total - left) / total)) : 0);
}

function renderDots() {
  const { state } = status;
  const box = $("dots");
  box.hidden = state.phase === "idle";
  box.replaceChildren();
  for (let i = 1; i <= state.cycles; i++) {
    const done = i < state.cycle || (i === state.cycle && state.phase === "soaking");
    const now = i === state.cycle && !done;
    const dot = document.createElement("i");
    dot.className = done ? "done" : now ? "now" : "";
    box.append(dot);
  }
  if (state.phase === "soaking" && state.cycle < state.cycles) box.children[state.cycle]?.classList.add("now", "soak");
}

function renderNotice() {
  const n = $("notice");
  const verdict = weather?.nextRun?.verdict;
  const config = status.config;
  const last = status.history[0];
  const planned = weather?.nextRun?.planned;
  const lastSkip = last && (last.outcome === "skipped-rain" || last.outcome === "skipped-weather") && nowMs() - last.at < 24 * 3600000;
  let html = "", cls = "";
  if (status.state.phase !== "idle") {
    html = ""; // nothing to explain while watering
  } else if (config.enabled && verdict?.skip) {
    cls = "delay";
    html = `<b>Rain delay active.</b> The ${when(weather.nextRun.at)} run will be skipped: ${esc(verdict.reason)}.${weather.current.isRaining ? "" : " It is dry right now."}`;
  } else if (config.enabled && planned?.state === "skip-weather") {
    cls = "delay";
    html = `<b>Next run will be skipped.</b> ${esc(planned.reason)}`;
  } else if (weather?.current.isRaining) {
    cls = "delay";
    html = `It is raining right now, so the garden is getting a free drink. The next run is still on.`;
  } else if (config.enabled && planned?.state === "will-run" && planned.percent !== 100 && planned.scaling) {
    html = `<b>Weather-adjusted.</b> ${esc(planned.scaling)}`;
  } else if (lastSkip) {
    cls = "delay";
    html = `<b>Last run skipped.</b> ${esc(last.note)}.`;
  } else if (config.enabled && weather?.nextRun?.note) {
    html = `Could not predict the next run: ${esc(weather.nextRun.note)}.`;
  }
  n.hidden = !html;
  n.className = `notice ${cls}`;
  n.innerHTML = html;
}

function renderButtons() {
  const running = status.state.phase !== "idle";
  $("start").hidden = running;
  $("stop").hidden = !running;
  $("start").disabled = busy;
  $("stop").disabled = busy;
  $("start").textContent = busy ? "Starting…" : "Water now";
}

const RUN_ICON = { "will-run": "💧", skip: "⏸️", "skip-weather": "🌡️", unknown: "❔", done: "✅", "skipped-earlier": "⏸️", failed: "⚠️", "no-record": "❔" };
const RUN_TEXT = { "will-run": "will water", skip: "will skip for rain", "skip-weather": "will skip for the weather", unknown: "not forecast yet", done: "watered", "skipped-earlier": "skipped", failed: "failed", "no-record": "no record" };

/** One badge per day: do we water, skip, or have nothing scheduled? */
function waterBadge(runs) {
  if (!runs?.length) return { cls: "none", icon: "·", short: "No run", text: "nothing scheduled" };
  const watering = runs.filter((r) => r.state === "will-run" || r.state === "done");
  const skipping = runs.filter((r) => r.state === "skip" || r.state === "skip-weather" || r.state === "skipped-earlier");
  const n = runs.length;
  if (watering.length === n) {
    const cycles = runs.every((r) => r.cycles) ? runs.reduce((sum, r) => sum + r.cycles, 0) : 0;
    const done = runs[0].state === "done";
    return { cls: "waters", icon: done ? "✅" : "💧", short: done ? "Done" : cycles ? `${cycles}×` : "Waters", text: cycles ? `waters ${cycles} cycle${cycles === 1 ? "" : "s"}` : `waters${n > 1 ? ` ${n} times` : ""}` };
  }
  if (skipping.length === n) {
    const weatherOnly = runs.every((r) => r.state === "skip-weather");
    return { cls: "skips", icon: weatherOnly ? "🌡️" : "⏸️", short: "Skips", text: weatherOnly ? "skipped for the weather" : "skipped for rain" };
  }
  if (watering.length && skipping.length) return { cls: "waters", icon: "💧", short: `${watering.length} of ${n}`, text: `${watering.length} of ${n} runs water` };
  const first = runs[0];
  return { cls: "unsure", icon: RUN_ICON[first.state], short: first.state === "failed" ? "Failed" : "Maybe", text: RUN_TEXT[first.state] };
}

function dayDetail(d, i) {
  const label = i === 0 ? "Today" : new Intl.DateTimeFormat([], { weekday: "long", timeZone: "UTC" }).format(new Date(`${d.date}T12:00:00Z`));
  if (!d.runs?.length) return `<b>${label}:</b> nothing is scheduled.`;
  return `<b>${label}:</b> ` + d.runs.map((r) => `${esc(when(r.at))} ${RUN_ICON[r.state]} ${RUN_TEXT[r.state]}${r.cycles ? `: ${r.cycles} cycles` : ""}${r.reason ? ` <span class="muted">(${esc(r.reason)})</span>` : ""}`).join("<br>");
}

function renderWeather() {
  const box = $("wx-body");
  if (!weather) return;
  const c = weather.current;
  const maxMm = Math.max(10, ...weather.daily.map((d) => d.rainMm));
  const v = weather.nextRun;
  let verdictHtml = `<div class="verdict none"><span class="ico">💤</span><div><b>No upcoming run</b><span>Add a start time or switch scheduled runs on.</span></div></div>`;
  if (v) {
    const p = v.planned;
    if (p?.state === "skip-weather") verdictHtml = `<div class="verdict skip"><span class="ico">🌡️</span><div><b>${when(v.at)} will be skipped</b><span>${esc(p.reason)}</span></div></div>`;
    else if (p?.state === "will-run" && p.cycles) verdictHtml = `<div class="verdict go"><span class="ico">✅</span><div><b>${when(v.at)} will run ${p.cycles} cycle${p.cycles === 1 ? "" : "s"}${p.percent !== 100 ? ` (${p.percent}% of normal)` : ""}</b><span>${esc(p.reason)}</span></div></div>`;
    else if (v.verdict?.skip) verdictHtml = `<div class="verdict skip"><span class="ico">⏸️</span><div><b>${when(v.at)} will be skipped</b><span>${esc(v.verdict.reason)}</span></div></div>`;
    else if (v.verdict) verdictHtml = `<div class="verdict go"><span class="ico">✅</span><div><b>${when(v.at)} will run</b><span>${esc(v.verdict.reason)}</span></div></div>`;
    else verdictHtml = `<div class="verdict none"><span class="ico">❔</span><div><b>${when(v.at)}</b><span>${esc(v.note ?? "No forecast for that time yet. It will check again when it starts.")}</span></div></div>`;
  }
  const week = weather.daily.map((d, i) => {
    const label = i === 0 ? "Today" : new Intl.DateTimeFormat([], { weekday: "short", timeZone: "UTC" }).format(new Date(`${d.date}T12:00:00Z`));
    const water = waterBadge(d.runs);
    return `<button type="button" class="day ${water.cls}" data-i="${i}" aria-label="${esc(label)}: ${esc(water.text)}"><div class="d">${label}</div><div class="i" title="${d.condition.label}">${d.condition.icon}</div><div class="t">${d.tMaxC}° / ${d.tMinC}°</div>
      <div class="bar" title="${mm(d.rainMm)}"><i data-h="${Math.min(100, (d.rainMm / maxMm) * 100)}"></i></div><div class="mm">${d.rainMm >= 10 ? Math.round(d.rainMm) : d.rainMm}</div><div class="p">${d.chancePct}%</div>
      <div class="water"><span class="wi">${water.icon}</span><span class="wl">${water.short}</span></div></button>`;
  }).join("");
  box.innerHTML = `
    <div class="wx-now"><div class="wx-icon">${c.condition.icon}</div><div><div class="wx-temp">${Math.round(c.temperatureC)}°</div><div class="wx-label"${c.consensus ? ` title="${c.consensus.agreeing} of ${c.consensus.models} weather models agree"` : ""}>${c.condition.label}<span class="muted"> · feels ${Math.round(c.feelsLikeC)}°</span></div></div></div>
    <div class="tiles">
      <div class="tile ${c.rainLastHourMm > 0 ? "wet" : ""}"><span>Rain now</span><b>${mm(c.rainLastHourMm)}</b></div>
      <div class="tile"><span>Last 24 h</span><b>${mm(weather.past24hMm)}</b></div>
      <div class="tile"><span>Next 24 h</span><b>${mm(weather.next24hMm)}</b></div>
      <div class="tile"><span>Chance of rain</span><b>${weather.rainChanceNext24hPct}%</b></div>
      <div class="tile"><span>Humidity</span><b>${c.humidityPct}%</b></div>
      <div class="tile"><span>Wind</span><b>${c.windKmh} km/h</b></div>
      ${weather.etTodayMm !== undefined ? `<div class="tile" title="Water the garden loses today to heat, sun, wind and dry air"><span>Water use today</span><b>${weather.etTodayMm} mm</b></div>` : ""}
      ${weather.soilMoisture !== undefined ? `<div class="tile" title="Modelled soil moisture, top 28 cm"><span>Soil moisture</span><b>${Math.round(weather.soilMoisture * 100)}%</b></div>` : ""}
    </div>
    ${verdictHtml}
    <h3>Next 7 days</h3>
    <div class="week">${week}</div>
    <div class="legend"><span><i class="lg waters"></i>waters</span><span><i class="lg skips"></i>skipped for rain</span><span><i class="lg none"></i>no run</span></div>
    <div id="day-detail" class="day-detail" aria-live="polite">Tap a day to see its runs.</div>`;
  // Set here rather than in the markup: the page's CSP does not allow inline style attributes.
  box.querySelectorAll(".bar i[data-h]").forEach((i) => { i.style.height = `${i.dataset.h}%`; });
  box.querySelectorAll(".day").forEach((btn) => {
    btn.onclick = () => {
      selectedDay = Number(btn.dataset.i);
      box.querySelectorAll(".day").forEach((b) => b.classList.toggle("sel", b === btn));
      $("day-detail").innerHTML = dayDetail(weather.daily[selectedDay], selectedDay);
    };
  });
  if (selectedDay !== null && weather.daily[selectedDay]) box.querySelector(`.day[data-i="${selectedDay}"]`)?.click();
  $("wx-updated").textContent = weather.stale ? "showing older data" : `updated ${new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(weather.fetchedAt)}`;
  const chip = $("wx-chip");
  chip.hidden = false;
  chip.textContent = `${c.condition.icon} ${Math.round(c.temperatureC)}° ${c.condition.label}`;
}

function renderHistory() {
  const list = $("history");
  list.replaceChildren();
  if (!status.history.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing has run yet.";
    list.append(li);
    return;
  }
  const icons = { completed: "✅", stopped: "🛑", "skipped-rain": "🌧️", "skipped-weather": "🌡️", error: "⚠️" };
  const titles = { completed: "Watered", stopped: "Stopped", "skipped-rain": "Skipped for rain", "skipped-weather": "Skipped for the weather", error: "Failed" };
  for (const h of status.history) {
    const li = document.createElement("li");
    const detail = h.outcome === "skipped-rain" || h.outcome === "skipped-weather" || h.outcome === "error" ? h.note : `${Math.round(h.wateredSeconds / 60)} min · ${h.trigger}`;
    li.innerHTML = `<span class="ic"></span><div><div class="t"></div><div class="d"></div></div>`;
    li.querySelector(".ic").textContent = icons[h.outcome] ?? "•";
    li.querySelector(".t").textContent = `${titles[h.outcome] ?? h.outcome} · ${when(h.at)}`;
    li.querySelector(".d").textContent = detail; // notes can contain error text, so never inject as HTML
    list.append(li);
  }
}

function renderSettingsSummary() {
  const c = status.config;
  $("settings-summary").textContent = `${cyclesLabel(c.cycles)} of ${minutesLabel(c.onMinutes)}, ${minutesLabel(c.soakMinutes)} soak`;
}

function renderSchedules() {
  const box = $("schedules");
  box.replaceChildren();
  schedules.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "sched";
    // four ways to say when: a clock time, before sunrise, before sunset, after sunset
    const kindOf = (e) => (e.at === "dawn" ? "dawn" : e.at === "dusk" ? ((e.afterSunsetMin ?? 0) < 0 ? "dusk-before" : "dusk-after") : "clock");
    const minutesOf = (e) => (e.at === "dawn" ? e.beforeSunriseMin : Math.abs(e.afterSunsetMin ?? 30)) ?? 30;
    const setSun = (e, kindName, min) => {
      delete e.beforeSunriseMin; delete e.afterSunsetMin;
      if (kindName === "clock") { e.at = "clock"; return; }
      if (kindName === "dawn") { e.at = "dawn"; e.beforeSunriseMin = min; return; }
      e.at = "dusk"; e.afterSunsetMin = kindName === "dusk-before" ? -min : min;
    };
    const kind = document.createElement("select");
    kind.setAttribute("aria-label", "When to start: a time, or relative to sunrise or sunset");
    kind.className = "kind";
    kind.append(new Option("At time", "clock"), new Option("Before sunrise", "dawn"), new Option("Before sunset", "dusk-before"), new Option("After sunset", "dusk-after"));
    kind.value = kindOf(s);
    kind.onchange = () => { setSun(s, kind.value, minutesOf(s)); renderSchedules(); };
    const time = Object.assign(document.createElement("input"), { type: "time", value: s.time });
    time.setAttribute("aria-label", "Start time");
    time.onchange = () => (s.time = time.value);
    const lead = document.createElement("div");
    lead.className = "num lead";
    const mins = Object.assign(document.createElement("input"), { type: "number", min: 0, max: 180, inputmode: "numeric", value: minutesOf(s) });
    mins.setAttribute("aria-label", "Minutes from sunrise or sunset");
    mins.onchange = () => setSun(s, kindOf(s), Number(mins.value));
    lead.append(mins, Object.assign(document.createElement("em"), { textContent: kindOf(s) === "dusk-after" ? "min after" : "min before" }));
    const when = s.at === "dawn" || s.at === "dusk" ? lead : time;
    // an extra run: leave empty to run every day, or set the ET (mm) the day must reach
    const only = document.createElement("div");
    only.className = "num only";
    only.title = "Leave empty to run on every selected day. Set a number to make this an extra run that only happens on hot days.";
    const et = Object.assign(document.createElement("input"), { type: "number", min: 0.5, max: 20, step: "any", inputmode: "decimal", placeholder: "any day", value: s.onlyIfEtMm ?? "" });
    et.setAttribute("aria-label", "Only when evapotranspiration is at least this many mm");
    et.onchange = () => { if (et.value === "") delete s.onlyIfEtMm; else s.onlyIfEtMm = Number(et.value); };
    only.append(Object.assign(document.createElement("em"), { textContent: "Extra run: only if ET ≥" }), et, Object.assign(document.createElement("em"), { textContent: "mm" }));
    const chips = document.createElement("div");
    chips.className = "chips";
    DAYS.forEach((name, d) => {
      const label = document.createElement("label");
      const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: s.days.includes(d) });
      cb.onchange = () => (s.days = cb.checked ? [...s.days, d] : s.days.filter((x) => x !== d));
      const span = Object.assign(document.createElement("span"), { textContent: name });
      label.append(cb, span);
      chips.append(label);
    });
    const del = Object.assign(document.createElement("button"), { type: "button", className: "x", textContent: "✕", title: "Remove" });
    del.setAttribute("aria-label", "Remove start time");
    del.onclick = () => { schedules.splice(i, 1); renderSchedules(); };
    row.append(kind, when, chips, del, only);
    box.append(row);
  });
}

function fillForm(c) {
  $("enabled").checked = c.enabled;
  $("onMinutes").value = c.onMinutes;
  $("soakMinutes").value = c.soakMinutes;
  $("cycles").value = c.cycles;
  $("rainEnabled").checked = c.rain.enabled;
  $("lookaheadHours").value = c.rain.lookaheadHours;
  $("probabilityPct").value = c.rain.probabilityPct;
  $("mm").value = c.rain.mm;
  const sm = c.smart;
  $("smartEnabled").checked = sm.enabled;
  $("referenceEtMm").value = sm.referenceEtMm;
  $("cropFactor").value = sm.cropFactor;
  $("minPercent").value = sm.minPercent;
  $("maxPercent").value = sm.maxPercent;
  $("soilDryBelow").value = sm.soilDryBelow;
  $("soilWetAbove").value = sm.soilWetAbove;
  $("windEnabled").checked = sm.wind.enabled;
  $("windMaxKmh").value = sm.wind.maxKmh;
  $("frostEnabled").checked = sm.frost.enabled;
  $("frostBelowC").value = sm.frost.belowC;
  schedules = structuredClone(c.schedules);
  renderSchedules();
}

function renderAll() {
  renderScene();
  renderTicking();
  renderDots();
  renderNotice();
  renderButtons();
  renderWeather();
  renderHistory();
  renderSettingsSummary();
}

/* ───────────────────────── data ───────────────────────── */

function toast(text, isError = false) {
  const t = $("toast");
  t.textContent = text;
  t.className = `toast${isError ? " error" : ""}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 5000);
}

async function api(path, options = {}) {
  // The Cloudflare Access cookie travels with same-origin requests. When the session expires the
  // login redirect makes fetch fail, so the fix is to reload the page and sign in again.
  let res;
  try {
    res = await fetch(`/api${path}`, { ...options, headers: { "content-type": "application/json" } });
  } catch {
    throw new Error("Session expired or offline. Reload the page to sign in again.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? body.message ?? res.statusText), { body });
  return body;
}

function setConn(ok, text) {
  const c = $("conn");
  c.className = `conn ${ok ? "ok" : "bad"}`;
  c.textContent = text;
}

let statusKey = "";
async function refreshStatus(withForm = false) {
  try {
    status = await api("/status");
    skew = status.now - Date.now();
    setConn(true, "Live");
    if (withForm) fillForm(status.config);
    // Most polls return what we already drew (the clock aside), so only redraw when something changed.
    const key = JSON.stringify({ ...status, now: 0 });
    if (withForm || key !== statusKey) renderAll();
    statusKey = key;
  } catch (e) {
    setConn(false, "Offline");
    if (!status) toast(e.message, true);
  }
}

let weatherRetry;
async function refreshWeather() {
  clearTimeout(weatherRetry);
  try {
    weather = await api("/weather");
    if (status) renderAll();
  } catch (e) {
    if (!weather) {
      $("wx-body").innerHTML = `<p class="muted">Weather is unavailable right now (${esc(e.message)}). Trying again shortly.</p><button class="btn btn-ghost" id="wx-retry" type="button">Retry now</button>`;
      $("wx-retry").onclick = () => { $("wx-retry").disabled = true; refreshWeather(); };
      if (status) renderAll(); // redraw the sky without weather data
      weatherRetry = setTimeout(refreshWeather, 30000);
    }
  }
}

function renderValve() {
  const chip = $("valve-chip");
  if (!valve) return;
  chip.hidden = false;
  chip.disabled = false;
  chip.onclick = null;
  if (valve.loginExpired) {
    chip.className = "chip warn action";
    chip.textContent = "🔑 Tuya login expired · reconnect";
    chip.title = valve.error;
    chip.onclick = openReconnect;
  } else if (valve.error) {
    chip.className = "chip warn";
    chip.textContent = "🚰 valve unreachable";
    chip.title = valve.error;
  } else {
    // with fewer logins than wanted, one more dead login would take the valve out of reach, so offer to add a backup
    const short = valve.logins && valve.logins.live < valve.logins.wanted;
    chip.className = `chip${valve.online && !short ? "" : " warn"}${short ? " action" : ""}`;
    const battery = valve.batteryPct === undefined ? "" : ` · 🔋 ${valve.batteryPct}%`;
    const backup = short ? ` · 🔑 ${valve.logins.live} of ${valve.logins.wanted} logins, add a backup` : "";
    chip.textContent = `🚰 ${valve.online ? "online" : "offline"}${battery}${backup}`;
    chip.title = valve.open ? "The valve reports open" : "The valve reports closed";
    if (short) chip.onclick = openReconnect;
  }
}

// One Tuya call, not one per status poll: the valve's own state changes rarely and Tuya's API is rate limited.
async function refreshValve() {
  try {
    valve = await api("/valve");
  } catch (e) {
    valve = { error: e.message, loginExpired: !!e.body?.loginExpired };
  }
  renderValve();
}

/* ───────────────────────── reconnect Tuya ───────────────────────── */

let reconnectTimer = null;

async function reconnectCode() {
  clearTimeout(reconnectTimer);
  $("reconnect-qr").replaceChildren();
  try {
    showReconnect(await api("/tuya/login", { method: "POST" }));
  } catch (e) {
    $("reconnect-text").textContent = e.message;
  }
}

function showReconnect(r) {
  if (r.state === "waiting") {
    // the server builds this SVG from Tuya's token: one path, no scripts or styles
    $("reconnect-qr").innerHTML = r.svg;
    reconnectTimer = setTimeout(pollReconnect, 3000);
  } else if (r.state === "done") {
    $("reconnect").close();
    const n = r.logins.live;
    toast(n >= r.logins.wanted ? `Tuya is connected with ${n} logins.` : `Tuya is connected, with ${n} login. Tuya signed the older one out, so there is no backup yet.`);
    refreshValve();
  } else {
    $("reconnect-qr").replaceChildren();
    $("reconnect-text").textContent = "That code ran out. Press New code to try again.";
  }
}

async function pollReconnect() {
  if (!$("reconnect").open) return;
  try {
    showReconnect(await api("/tuya/login"));
  } catch (e) {
    $("reconnect-text").textContent = e.message;
  }
}

function openReconnect() {
  $("reconnect-text").textContent = valve?.loginExpired
    ? "Tuya no longer accepts the saved login. Scan this code with the Smart Life app (Me, then the scan icon) to sign in again."
    : "Scan this code with the Smart Life app (Me, then the scan icon) to add a backup login. The valve keeps working on the other login if one stops.";
  $("reconnect").showModal();
  reconnectCode();
}
$("reconnect-new").onclick = reconnectCode;
$("reconnect-close").onclick = () => $("reconnect").close();
$("reconnect").addEventListener("close", () => clearTimeout(reconnectTimer));

async function act(path, okText) {
  busy = true;
  if (status) renderButtons();
  try {
    const r = await api(path, { method: "POST" });
    toast(r.message ?? okText, r.ok === false);
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy = false;
    // the scene only changes once the controller reports the valve state, never on the click itself
    await refreshStatus();
    refreshWeather();
    refreshValve();
  }
}

/* ───────────────────────── wiring ───────────────────────── */

buildScene();

$("start").onclick = () => act("/start", "Started");
$("stop").onclick = () => act("/stop", "Stopped");
$("add-schedule").onclick = () => { schedules.push({ days: [0, 1, 2, 3, 4, 5, 6], at: "clock", time: "06:00" }); renderSchedules(); };
$("config").onsubmit = async (e) => {
  e.preventDefault();
  const n = (id) => Number($(id).value);
  const config = {
    enabled: $("enabled").checked, onMinutes: n("onMinutes"), soakMinutes: n("soakMinutes"), cycles: n("cycles"), schedules,
    rain: { enabled: $("rainEnabled").checked, lookaheadHours: n("lookaheadHours"), probabilityPct: n("probabilityPct"), mm: n("mm") },
    smart: {
      enabled: $("smartEnabled").checked, referenceEtMm: n("referenceEtMm"), cropFactor: n("cropFactor"), minPercent: n("minPercent"), maxPercent: n("maxPercent"),
      soilDryBelow: n("soilDryBelow"), soilWetAbove: n("soilWetAbove"),
      wind: { enabled: $("windEnabled").checked, maxKmh: n("windMaxKmh") }, frost: { enabled: $("frostEnabled").checked, belowC: n("frostBelowC") },
    },
  };
  try {
    fillForm(await api("/config", { method: "PUT", body: JSON.stringify(config) }));
    toast("Saved");
    await refreshStatus();
    refreshWeather();
  } catch (err) {
    toast(err.message, true);
  }
};

if (demo) {
  const d = demoData(demo);
  status = d.status;
  weather = d.weather;
  valve = { online: true, open: demo === "watering", batteryPct: 92 };
  renderValve();
  setConn(true, `Demo: ${demo}`);
  fillForm(status.config);
  renderAll();
  setInterval(renderTicking, 1000);
} else {
  refreshStatus(true);
  refreshWeather();
  refreshValve();
  setInterval(() => !document.hidden && refreshValve(), 5 * 60000);
  // quick while a run is on, relaxed when idle
  (function pollStatus() {
    setTimeout(() => {
      if (!document.hidden) refreshStatus();
      pollStatus();
    }, status?.state.phase === "idle" ? 15000 : 4000);
  })();
  setInterval(() => !document.hidden && refreshWeather(), 5 * 60000);
  setInterval(renderTicking, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { refreshStatus(); refreshWeather(); refreshValve(); } });
}

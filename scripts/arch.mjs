#!/usr/bin/env node
// Keeps docs/architecture in step with the code.
//
//   check           print whether the diagram is stale (exit 1 when it is)
//   finalize        validate, deliver and browser-check the diagram with archify
//   bump            pin the diagram to the current HEAD, then finalize (to re-verify every citation)
//   hook-commit     Claude Code PostToolUse hook: after a git commit, tell the agent if the diagram is stale
//   hook-stop       Claude Code Stop hook: once per stop, ask the agent to update a stale diagram
//
// "Stale" means a file that feeds the diagram changed in a commit after the revision the diagram was verified
// against. Uncommitted edits are reported but do not count, because archify checks citations against committed bytes.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE = "docs/architecture/architecture.json";
const RECEIPTS = "docs/architecture/.receipts"; // machine-local, not committed
const LAST = `${RECEIPTS}/last-finalize.json`;
const OUTPUT = "docs/architecture/architecture.html";
const ARCHIFY = ".claude/skills/archify/bin/archify.mjs";

// Everything a runtime diagram depends on. Tests, docs and lockfiles are left out on purpose.
const WATCHED = [
  ":(glob)agent/*.py",
  "agent/Dockerfile",
  "agent/compose.yaml",
  "worker/src",
  "worker/wrangler.jsonc",
  "worker/public/index.html",
  ":(glob)infra/*.tf",
];

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const lines = (s) => s.split("\n").filter(Boolean);

function status() {
  const doc = JSON.parse(readFileSync(join(ROOT, CANDIDATE), "utf8"));
  const rev = doc.meta?.repository?.revision;
  const head = git("rev-parse", "HEAD");
  let committed = [];
  let reason = "";
  try {
    git("cat-file", "-e", `${rev}^{commit}`);
    committed = lines(git("diff", "--name-only", rev, "HEAD", "--", ...WATCHED));
  } catch {
    reason = "the pinned revision is not in this repository";
  }
  const uncommitted = lines(git("status", "--porcelain", "--", ...WATCHED)).map((l) => l.replace(/^\s*\S+\s+/, ""));

  // The last local finalize must have passed for exactly this candidate, otherwise the HTML may not match the JSON.
  // The record is not committed, so a fresh checkout without one is not nagged.
  let unverified = "";
  const lastPath = join(ROOT, LAST);
  if (existsSync(lastPath)) {
    const last = JSON.parse(readFileSync(lastPath, "utf8"));
    const sha = sha256(join(ROOT, CANDIDATE));
    if (last.sha256 !== sha) unverified = `${CANDIDATE} was edited after the last finalize`;
    else if (!last.ok) unverified = "the last finalize failed";
  }
  return { rev, head, committed, uncommitted, unverified, stale: !!reason || committed.length > 0 || !!unverified, reason };
}

function instructions(s) {
  const why = [];
  if (s.committed.length) why.push(`These files changed since the diagram was verified (${s.rev.slice(0, 7)}): ${s.committed.join(", ")}.`);
  if (s.reason) why.push(`${s.reason[0].toUpperCase()}${s.reason.slice(1)}.`);
  if (s.unverified) why.push(`${s.unverified[0].toUpperCase()}${s.unverified.slice(1)}, so the HTML may not match the JSON.`);
  return [
    `The architecture diagram needs attention. ${why.join(" ")}`,
    s.committed.length || s.reason
      ? `Use the archify skill to update ${CANDIDATE}: re-read the changed files, correct the components, connections and cards that changed, and fix any source line ranges that moved. Then run \`node scripts/arch.mjs bump\` (pins the diagram to HEAD and re-verifies every citation). If nothing about the architecture changed, only run bump.`
      : `Run \`node scripts/arch.mjs finalize\` and fix whatever it reports.`,
    `Repeat edit + \`node scripts/arch.mjs finalize\` until it passes, then commit ${CANDIDATE} and ${OUTPUT}.`,
  ].join(" ");
}

function evidenceRoot(url, rev) {
  let origin = "";
  try {
    origin = git("remote", "get-url", "origin");
  } catch {}
  if (origin === url) return { root: ROOT, cleanup() {} };
  // archify needs an origin that matches the diagram's repository address. Without a matching one,
  // verify against a throwaway clone of the pinned revision that carries that address.
  const dir = mkdtempSync(join(tmpdir(), "arch-evidence-"));
  execFileSync("git", ["clone", "-q", "--local", "--no-checkout", ROOT, dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "checkout", "-q", rev], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "set-url", "origin", url], { stdio: "ignore" });
  return { root: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function finalize() {
  const repo = JSON.parse(readFileSync(join(ROOT, CANDIDATE), "utf8")).meta.repository;
  const candidateSha = sha256(join(ROOT, CANDIDATE));
  const ev = evidenceRoot(repo.url, repo.revision);
  // archify ties browser evidence to exact HTML bytes, so every run gets its own evidence folder.
  const runDir = `${RECEIPTS}/${Date.now()}`;
  try {
    const r = spawnSync("node", [ARCHIFY, "finalize", "architecture", CANDIDATE, OUTPUT, "--repo-root", ev.root, "--quality", "showcase", "--out-dir", runDir, "--json"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: "1" },
    });
    let out;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      console.error(r.stdout || r.stderr);
      out = { ok: false };
    }
    mkdirSync(join(ROOT, RECEIPTS), { recursive: true });
    writeFileSync(join(ROOT, LAST), `${JSON.stringify({ ok: !!out.ok, sha256: candidateSha, at: new Date().toISOString() })}\n`);
    for (const dir of readdirSync(join(ROOT, RECEIPTS)).filter((n) => /^\d+$/.test(n)).sort().slice(0, -3)) rmSync(join(ROOT, RECEIPTS, dir), { recursive: true, force: true });
    if (out.gates) console.log(out.ok ? `archify: pass (${Object.entries(out.gates).map(([k, v]) => `${k}=${v}`).join(", ")})` : `archify: FAIL at ${out.failedStage}`);
    for (const d of out.diagnostics ?? []) console.log(`- ${d.code}: ${d.message}${d.subject?.path ? ` [${d.subject.path}]` : ""}${d.supportedFixes ? `\n    fix: ${d.supportedFixes.join("; ")}` : ""}`);
    return out.ok ? 0 : 1;
  } finally {
    ev.cleanup();
  }
}

function bump() {
  const p = join(ROOT, CANDIDATE);
  const doc = JSON.parse(readFileSync(p, "utf8"));
  doc.meta.repository.revision = git("rev-parse", "HEAD");
  writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
  return finalize();
}

async function stdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

const COMMIT = /\bgit\s+(?:-C\s+\S+\s+)?commit\b|\bg(?:feat|fix|docs|style|ref|test|chore|perf|ci|depup|depdown|wip)\b/;

const INSTALL = "npx skills add tt-a1i/archify --skill archify --agent claude-code --copy --yes";
const haveArchify = existsSync(join(ROOT, ARCHIFY));
const [, , cmd] = process.argv;
// The skill is installed per machine (it is large), so hooks stay quiet when it is missing.
if (!haveArchify && cmd !== "check") {
  if (cmd === "finalize" || cmd === "bump") {
    console.error(`archify is not installed here. Install it with: ${INSTALL}`);
    process.exit(2);
  }
  process.exit(0);
}
if (cmd === "check") {
  const s = status();
  console.log(JSON.stringify(s, null, 2));
  if (s.stale) console.error(instructions(s));
  process.exit(s.stale ? 1 : 0);
} else if (cmd === "finalize") {
  process.exit(finalize());
} else if (cmd === "bump") {
  process.exit(bump());
} else if (cmd === "hook-commit") {
  const input = await stdinJson();
  if (input.tool_name === "Bash" && COMMIT.test(input.tool_input?.command ?? "")) {
    const s = status();
    if (s.stale) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: instructions(s) } }));
  }
} else if (cmd === "hook-stop") {
  const input = await stdinJson();
  if (!input.stop_hook_active) {
    const s = status();
    if (s.stale) console.log(JSON.stringify({ decision: "block", reason: instructions(s) }));
  }
} else {
  console.error("usage: arch.mjs check | finalize | bump | hook-commit | hook-stop");
  process.exit(2);
}

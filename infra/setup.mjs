#!/usr/bin/env node
// One-time setup for the Terraform state backend. Safe to run again.
//
//   node setup.mjs [--rotate] [--dry-run]        (CLOUDFLARE_API_TOKEN from the environment or .env)
//
// It creates the private R2 bucket that holds the state, creates R2 keys that can only touch that bucket, and writes
// backend.hcl, .env (git-ignored, mode 600; other lines in it are kept) and, if missing, terraform.tfvars with your account id filled in.
// CLOUDFLARE_API_TOKEN may live in .env (see .env.example).
//
// The token you run it with needs, on the account: "Account API Tokens: Edit" (to create the R2 keys) and
// "Workers R2 Storage: Edit" (to create the bucket). It is only used here. Terraform itself should use a narrower token.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const API = process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4";
const PERMISSION = "Workers R2 Storage Bucket Item Write"; // read, write and list objects in chosen buckets
const envPath = join(DIR, ".env");
const parseEnv = () =>
  Object.fromEntries(
    (existsSync(envPath) ? readFileSync(envPath, "utf8") : "").split("\n").filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
// .env is the home for every Terraform secret. Anything already in the environment wins over it.
for (const [k, v] of Object.entries(parseEnv())) process.env[k] ??= v;
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const rotate = args.has("--rotate");

const say = (msg) => console.log(msg);
const fail = (msg) => {
  console.error(`\nerror: ${msg}`);
  process.exit(1);
};

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) fail("set CLOUDFLARE_API_TOKEN in the environment or infra/.env (see the top of this file for the permissions it needs).");

// Keep the bucket name in one place: the backend block in versions.tf.
const bucket = /bucket\s*=\s*"([^"]+)"/.exec(readFileSync(join(DIR, "versions.tf"), "utf8"))?.[1];
if (!bucket) fail("could not read the bucket name from versions.tf.");

async function cf(method, path, body) {
  if (dryRun && method !== "GET") {
    say(`  [dry run] ${method} ${path}`);
    return { success: true, result: { id: "dry-run", value: "dry-run" } };
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json, success: res.ok && json.success !== false };
}

const explain = (r) => (r.errors?.length ? r.errors.map((e) => `${e.message}${e.code ? ` (${e.code})` : ""}`).join("; ") : `HTTP ${r.status}`);

// 1. account
let account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) {
  const r = await cf("GET", "/accounts");
  if (!r.success) fail(`could not list accounts: ${explain(r)}. Check the token, or set CLOUDFLARE_ACCOUNT_ID.`);
  if (r.result.length !== 1) fail(`the token sees ${r.result.length} accounts (${r.result.map((a) => `${a.name}: ${a.id}`).join(", ")}). Set CLOUDFLARE_ACCOUNT_ID to pick one.`);
  account = r.result[0].id;
  say(`account: ${r.result[0].name} (${account})`);
} else {
  say(`account: ${account}`);
}

// 2. bucket
const existing = await cf("GET", `/accounts/${account}/r2/buckets/${bucket}`);
if (existing.success) {
  say(`bucket ${bucket}: already exists`);
} else {
  const r = await cf("POST", `/accounts/${account}/r2/buckets`, { name: bucket });
  if (!r.success) fail(`could not create bucket ${bucket}: ${explain(r)}. The token needs "Workers R2 Storage: Edit", and R2 must be enabled on the account.`);
  say(dryRun ? `bucket ${bucket}: would be created` : `bucket ${bucket}: created`);
}

// 3. R2 keys limited to that bucket
const current = parseEnv();
let keys = current.AWS_ACCESS_KEY_ID && current.AWS_SECRET_ACCESS_KEY && !rotate ? { id: current.AWS_ACCESS_KEY_ID, secret: current.AWS_SECRET_ACCESS_KEY } : null;

if (keys) {
  say("R2 keys: already in .env (use --rotate to replace them)");
} else {
  const groups = await cf("GET", `/accounts/${account}/tokens/permission_groups`);
  if (!groups.success) fail(`could not list permission groups: ${explain(groups)}. The token needs "Account API Tokens: Edit".`);
  const group = groups.result.find((g) => g.name === PERMISSION);
  if (!group) fail(`Cloudflare has no permission group named "${PERMISSION}".`);

  const created = await cf("POST", `/accounts/${account}/tokens`, {
    name: `valve-controller terraform state (${bucket})`,
    policies: [{ effect: "allow", resources: { [`com.cloudflare.edge.r2.bucket.${account}_default_${bucket}`]: "*" }, permission_groups: [{ id: group.id }] }],
  });
  if (!created.success) fail(`could not create the R2 keys: ${explain(created)}. The token needs "Account API Tokens: Edit". Or create keys by hand (R2 > Manage R2 API tokens, Object Read & Write on ${bucket}) and put AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in infra/.env.`);

  // R2 turns an API token into S3 credentials: the key id is the token id, the secret is the SHA-256 of its value.
  keys = { id: created.result.id, secret: createHash("sha256").update(created.result.value).digest("hex") };
  say(dryRun ? "R2 keys: would be created, limited to that bucket" : "R2 keys: created, limited to that bucket");

  if (rotate && current.AWS_ACCESS_KEY_ID) {
    const old = await cf("DELETE", `/accounts/${account}/tokens/${current.AWS_ACCESS_KEY_ID}`);
    say(old.success ? "R2 keys: old ones revoked" : `R2 keys: could not revoke the old ones (${explain(old)}); delete them in the dashboard`);
  }
}

// 4. files
if (dryRun) {
  say("\n[dry run] no files written");
  process.exit(0);
}
writeFileSync(join(DIR, "backend.hcl"), `endpoints = { s3 = "https://${account}.r2.cloudflarestorage.com" }\n`);
// Merge into .env: replace only the two R2 key lines and keep everything else (your other secrets, comments).
const kept = (existsSync(envPath) ? readFileSync(envPath, "utf8") : "").split("\n").filter((l) => !/^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)=/.test(l));
while (kept.length && kept[kept.length - 1] === "") kept.pop();
writeFileSync(envPath, `${[...kept, `AWS_ACCESS_KEY_ID=${keys.id}`, `AWS_SECRET_ACCESS_KEY=${keys.secret}`].join("\n")}\n`);
chmodSync(envPath, 0o600);
say("wrote backend.hcl and updated .env (mode 600, git-ignored)");

const tfvars = join(DIR, "terraform.tfvars");
if (!existsSync(tfvars)) {
  copyFileSync(join(DIR, "terraform.tfvars.example"), tfvars);
  writeFileSync(tfvars, readFileSync(tfvars, "utf8").replace(/cloudflare_account_id\s*=\s*"[^"]*"/, `cloudflare_account_id = "${account}"`));
  say("wrote terraform.tfvars with your account id filled in");
}

say(`
Next:
  1. Edit terraform.tfvars: zone, hostnames, your email, timezone and coordinates.
  2. export CLOUDFLARE_API_TOKEN=<a token for Terraform>   (permissions are listed in versions.tf; use a narrower one than this script's)
     export TF_VAR_healthchecks_api_key=<healthchecks.io project key>
  3. make init && make apply
`);

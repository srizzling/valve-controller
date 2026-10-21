#!/usr/bin/env node
// Creates the narrow Cloudflare API token Terraform (and CI) should use, and puts it in .env. Safe to run again.
//
//   node terraform-token.mjs [--rotate] [--dry-run]
//
// It signs in with the broader setup token (CLOUDFLARE_SETUP_TOKEN, or CLOUDFLARE_API_TOKEN the first time), then:
//   - creates a token with only what the Terraform in this repo manages,
//   - keeps the setup token in .env as CLOUDFLARE_SETUP_TOKEN (so `make setup` still works),
//   - saves the new token as CLOUDFLARE_API_TOKEN (what `make` and CI use).
// Zone permissions are limited to the zone_name in terraform.tfvars once that zone exists in your account; until then
// they cover the zones in this account, so run it again after adding your domain to narrow them.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const API = process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4";
const envPath = join(DIR, ".env");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const rotate = args.has("--rotate");

const parseEnv = () =>
  Object.fromEntries(
    (existsSync(envPath) ? readFileSync(envPath, "utf8") : "").split("\n").filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
const env = { ...parseEnv(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CLOUDFLARE_"))) };
const say = (m) => console.log(m);
const fail = (m) => {
  console.error(`\nerror: ${m}`);
  process.exit(1);
};

// What the Terraform in infra/ touches. Names are Cloudflare's own permission group names.
const ACCOUNT_GROUPS = [
  "Workers Scripts Write", // worker, versions, deployment, cron trigger, custom domain, workers.dev switch
  "Cloudflare Tunnel Write", // tunnel, its config and its token
  "Access: Apps and Policies Write", // the two Access applications and their policies
];
const ZONE_GROUPS = [
  "Zone Read", // look the zone up by name
  "DNS Write", // CNAME to the tunnel
  "Workers Routes Write", // custom domain for the Worker
];

const setupToken = env.CLOUDFLARE_SETUP_TOKEN ?? env.CLOUDFLARE_API_TOKEN;
if (!setupToken) fail("no token found: put CLOUDFLARE_API_TOKEN (with API Tokens: Edit) in infra/.env first.");

async function cf(method, path, body, token = setupToken) {
  if (dryRun && method !== "GET") return { success: true, result: { id: "dry-run", value: "dry-run" } };
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json, success: res.ok && json.success !== false };
}
const explain = (r) => (r.errors?.length ? r.errors.map((e) => `${e.message}${e.code ? ` (${e.code})` : ""}`).join("; ") : `HTTP ${r.status}`);

const tfvarsPath = join(DIR, "terraform.tfvars");
const tfvars = existsSync(tfvarsPath) ? readFileSync(tfvarsPath, "utf8") : "";
const fromTfvars = (key) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m").exec(tfvars)?.[1];

let account = env.CLOUDFLARE_ACCOUNT_ID ?? fromTfvars("cloudflare_account_id");
if (!account) {
  const r = await cf("GET", "/accounts");
  if (!r.success || r.result.length !== 1) fail("could not work out the account id; set CLOUDFLARE_ACCOUNT_ID.");
  account = r.result[0].id;
}
say(`account: ${account}`);

// Already done? The setup token is parked in .env after the first run.
if (env.CLOUDFLARE_SETUP_TOKEN && !rotate) {
  say("Terraform token: already created (CLOUDFLARE_SETUP_TOKEN is in .env). Use --rotate to replace it, e.g. after adding your domain.");
  process.exit(0);
}

// Zone scope
let zoneResources;
const zoneName = fromTfvars("zone_name");
let zone;
if (zoneName && zoneName !== "example.com") {
  // The setup token often cannot read zones, so also try the Terraform token if there already is one.
  for (const token of [setupToken, env.CLOUDFLARE_API_TOKEN].filter(Boolean)) {
    const r = await cf("GET", `/zones?name=${encodeURIComponent(zoneName)}&account.id=${account}`, undefined, token);
    zone = r.success ? r.result?.[0] : undefined;
    if (zone) break;
  }
}
if (zone) {
  zoneResources = { [`com.cloudflare.api.account.zone.${zone.id}`]: "*" };
  say(`zone: limited to ${zone.name}`);
} else {
  zoneResources = { [`com.cloudflare.api.account.${account}`]: { "com.cloudflare.api.account.zone.*": "*" } };
  say(`zone: ${zoneName && zoneName !== "example.com" ? `${zoneName} is not in this account yet` : "zone_name is not set yet"}, so DNS and route permissions cover all zones in this account.\n      Add your domain to Cloudflare, fill in zone_name, then run this again with --rotate to narrow it.`);
}

const groups = await cf("GET", `/accounts/${account}/tokens/permission_groups`);
if (!groups.success) fail(`could not list permission groups: ${explain(groups)}. The setup token needs "Account API Tokens: Edit".`);
const pick = (name, scope) => {
  const g = groups.result.find((x) => x.name === name && (x.scopes ?? []).some((s) => (scope === "zone" ? s.endsWith(".zone") : s.endsWith(".account"))));
  if (!g) fail(`Cloudflare has no ${scope}-level permission group named "${name}".`);
  return { id: g.id };
};

const body = {
  name: "valve-controller terraform",
  policies: [
    { effect: "allow", resources: { [`com.cloudflare.api.account.${account}`]: "*" }, permission_groups: ACCOUNT_GROUPS.map((n) => pick(n, "account")) },
    { effect: "allow", resources: zoneResources, permission_groups: ZONE_GROUPS.map((n) => pick(n, "zone")) },
  ],
};
say(`permissions: account [${ACCOUNT_GROUPS.join(", ")}], zone [${ZONE_GROUPS.join(", ")}]`);

// When replacing, remember the token we are about to retire so it can be revoked.
let oldId;
if (rotate && env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_SETUP_TOKEN) {
  const v = await cf("GET", `/accounts/${account}/tokens/verify`, undefined, env.CLOUDFLARE_API_TOKEN);
  oldId = v.success ? v.result?.id : undefined;
}

const created = await cf("POST", `/accounts/${account}/tokens`, body);
if (!created.success) fail(`could not create the token: ${explain(created)}`);
say(dryRun ? "token: would be created" : "token: created");

if (dryRun) {
  say("\n[dry run] .env not changed");
  process.exit(0);
}

// Check it before trusting it: it must be active, and each area it should reach must answer.
const verify = await cf("GET", `/accounts/${account}/tokens/verify`, undefined, created.result.value);
if (!verify.success || verify.result?.status !== "active") fail(`the new token did not verify: ${explain(verify)}. It was created but not saved; delete it in the dashboard.`);
const probes = [
  ["Workers", `/accounts/${account}/workers/scripts`],
  ["Tunnel", `/accounts/${account}/cfd_tunnel?per_page=1`],
  ["Access", `/accounts/${account}/access/apps?per_page=1`],
  ["Zones", `/zones?account.id=${account}&per_page=1`],
];
for (const [name, path] of probes) {
  const r = await cf("GET", path, undefined, created.result.value);
  say(`  can read ${name}: ${r.success ? "yes" : `NO (${explain(r)})`}`);
}

// Merge into .env: park the setup token, install the new one. Everything else is kept.
const kept = (existsSync(envPath) ? readFileSync(envPath, "utf8") : "").split("\n").filter((l) => !/^CLOUDFLARE_(API|SETUP)_TOKEN=/.test(l));
while (kept.length && kept[kept.length - 1] === "") kept.pop();
const parked = env.CLOUDFLARE_SETUP_TOKEN ?? env.CLOUDFLARE_API_TOKEN;
writeFileSync(envPath, `${[...kept, `CLOUDFLARE_SETUP_TOKEN=${parked}`, `CLOUDFLARE_API_TOKEN=${created.result.value}`].join("\n")}\n`);
chmodSync(envPath, 0o600);
say("saved: CLOUDFLARE_API_TOKEN is now the narrow Terraform token; the setup token is kept as CLOUDFLARE_SETUP_TOKEN");

if (oldId) {
  const d = await cf("DELETE", `/accounts/${account}/tokens/${oldId}`);
  say(d.success ? "old Terraform token: revoked" : `old Terraform token: could not revoke (${explain(d)})`);
}
say("\nThe setup token can create other tokens, so consider deleting it in the dashboard once setup is finished with.");

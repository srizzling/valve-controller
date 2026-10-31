#!/usr/bin/env node
// Configures the GitHub repository from code. Uses the `gh` CLI, so run `gh auth login` first. Safe to run again.
//
//   node scripts/github-setup.mjs settings   repo settings, Dependabot alerts, Actions defaults  (default)
//   node scripts/github-setup.mjs secrets    copy infra/.env and infra/terraform.tfvars into Actions secrets and variables
//   node scripts/github-setup.mjs all
//
//   --no-protect     do not protect main (by default it needs a PR and a passing ci-ok; needs GitHub Pro or a public repo)
//   --dry-run        say what would change, change nothing (never prints secret values)
//   --env FILE       secrets file          (default infra/.env)
//   --tfvars FILE    Terraform variables   (default infra/terraform.tfvars)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const dryRun = argv.includes("--dry-run");
const command = argv.find((a, i) => !a.startsWith("--") && !["--env", "--tfvars"].includes(argv[i - 1])) ?? "settings";
const BRANCH = "main";
const protect = !argv.includes("--no-protect");
// Third-party actions the workflows may use, on top of GitHub's own. Each must be pinned to a commit (Renovate keeps the pins fresh).
const ALLOWED_ACTIONS = ["hashicorp/setup-terraform@*", "googleapis/release-please-action@*"];
const REQUIRED_CHECK = "ci-ok"; // the gate job in .github/workflows/ci.yml

// Terraform secrets that CI needs, by the same names they have in infra/.env.
const SECRETS = ["CLOUDFLARE_API_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "TF_VAR_healthchecks_api_key", "TF_VAR_tuya_session", "TF_VAR_ntfy_token", "TF_VAR_anthropic_api_key"];

const gh = (args, input) => spawnSync("gh", args, { encoding: "utf8", input });
const message = (r) => {
  try {
    return JSON.parse(r.stdout).message ?? r.stderr.trim();
  } catch {
    return (r.stderr || r.stdout).trim().split("\n")[0];
  }
};
const ok = (m) => console.log(`  ok       ${m}`);
const skip = (m) => console.log(`  skipped  ${m}`);
const warn = (m) => console.log(`  WARNING  ${m}`);

if (spawnSync("gh", ["--version"]).error) {
  console.error("The gh CLI is required: https://cli.github.com");
  process.exit(1);
}
const repoRes = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
if (repoRes.status !== 0) {
  console.error(`Could not find the GitHub repo: ${message(repoRes)}\nRun this from a clone with an origin on GitHub, after \`gh auth login\`.`);
  process.exit(1);
}
const repo = repoRes.stdout.trim();
console.log(`${repo}${dryRun ? " (dry run)" : ""}`);

function api(method, path, body, label) {
  if (dryRun) {
    skip(`${label} (${method} ${path})`);
    return { dry: true };
  }
  const args = ["api", "-X", method, path, ...(body ? ["--input", "-"] : [])];
  const r = gh(args, body ? JSON.stringify(body) : undefined);
  if (r.status === 0) ok(label);
  else warn(`${label}: ${message(r)}`);
  return { ok: r.status === 0, message: message(r) };
}

// Release tags (v1.2.3, made by Release Please) can be created but never moved or deleted.
function releaseTagRuleset() {
  console.log("\nRelease tags");
  const body = {
    name: "Protect release tags",
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "deletion" }, { type: "update" }, { type: "non_fast_forward" }],
    bypass_actors: [],
  };
  const list = gh(["api", `repos/${repo}/rulesets`]);
  const existing = list.status === 0 ? JSON.parse(list.stdout).find((r) => r.name === body.name) : undefined;
  api(existing ? "PUT" : "POST", existing ? `repos/${repo}/rulesets/${existing.id}` : `repos/${repo}/rulesets`, body, "v* tags cannot be moved or deleted");
}

function settings() {
  console.log("\nRepository settings");
  api("PATCH", `repos/${repo}`, {
    delete_branch_on_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_auto_merge: true,
    squash_merge_commit_title: "PR_TITLE",
    squash_merge_commit_message: "PR_BODY",
  }, "squash merges only, delete branches after merge, auto-merge allowed");

  console.log("\nDependency security");
  api("PUT", `repos/${repo}/vulnerability-alerts`, undefined, "Dependabot alerts on");
  // Renovate opens the fix PRs (it reads these alerts), so Dependabot must not open a second one for the same advisory.
  api("DELETE", `repos/${repo}/automated-security-fixes`, undefined, "Dependabot security PRs off (Renovate raises them)");
  api("PATCH", `repos/${repo}`, { security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" } } }, "secret scanning and push protection on");
  api("PUT", `repos/${repo}/private-vulnerability-reporting`, undefined, "private vulnerability reporting on (see SECURITY.md)");
  api("PATCH", `repos/${repo}/code-scanning/default-setup`, { state: "configured", query_suite: "default", languages: ["actions", "javascript-typescript", "python"] }, "CodeQL code scanning on (Worker, scripts and workflow files)");

  console.log("\nGitHub Actions");
  api("PUT", `repos/${repo}/actions/permissions/workflow`, { default_workflow_permissions: "read", can_approve_pull_request_reviews: true }, "workflows get a read-only token by default; Release Please may open its pull request");

  api("PUT", `repos/${repo}/actions/permissions`, { enabled: true, allowed_actions: "selected", sha_pinning_required: true }, "only allow-listed actions, each pinned to a full commit SHA");
  api("PUT", `repos/${repo}/actions/permissions/selected-actions`, { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ALLOWED_ACTIONS }, `allow-list: GitHub's own actions and ${ALLOWED_ACTIONS.join(", ")}`);

  // On a public repo, every workflow run from a first-time contributor's pull request waits for you to approve it.
  api("PUT", `repos/${repo}/actions/permissions/fork-pr-contributor-approval`, { approval_policy: "all_external_contributors" }, "pull requests from outside contributors need approval before workflows run");

  releaseTagRuleset();
  if (!protect) return console.log(`\nBranch protection on ${BRANCH}: skipped (--no-protect). A push to ${BRANCH} deploys, so only do this on a repo nobody else can write to.`);
  console.log(`\nBranch protection on ${BRANCH}`);
  const r = api("PUT", `repos/${repo}/branches/${BRANCH}/protection`, {
    required_status_checks: { strict: true, contexts: [REQUIRED_CHECK] },
    // Admins can still push in an emergency; GitHub flags every bypass. Set true to remove that escape hatch.
    enforce_admins: false,
    required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: true },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    required_conversation_resolution: true,
  }, `require a pull request and a passing ${REQUIRED_CHECK}, no force pushes or deletion, linear history`);
  if (r.message?.includes("Upgrade to GitHub Pro")) {
    console.log(`
  Branch protection is not available for a private repository on the free plan. Either:
    - upgrade to GitHub Pro, or
    - make the repository public (gh repo edit ${repo} --visibility public --accept-visibility-change-consequences),
  then run this script again.`);
  }
}

function parseEnv(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8").split("\n").filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

function secrets() {
  const envFile = flag("--env", join(ROOT, "infra/.env"));
  const tfvarsFile = flag("--tfvars", join(ROOT, "infra/terraform.tfvars"));
  console.log("\nActions secrets (from the env file)");
  if (!existsSync(envFile)) {
    warn(`${envFile} does not exist yet. Create it from infra/.env.example (and run \`make setup\` in infra/).`);
  } else {
    const env = parseEnv(envFile);
    for (const name of SECRETS) {
      if (!env[name]) {
        skip(`${name} is not set in the env file`);
      } else if (dryRun) {
        skip(`${name} would be set`);
      } else {
        const r = gh(["secret", "set", name, "--repo", repo], env[name]); // value goes over stdin, never argv
        if (r.status === 0) ok(`${name} set`);
        else warn(`${name}: ${message(r)}`);
      }
    }
  }

  console.log("\nActions variables (not secret: your hostnames, zone and email)");
  if (!existsSync(tfvarsFile)) {
    warn(`${tfvarsFile} does not exist yet. Run \`make setup\` in infra/ and fill it in.`);
    return;
  }
  const tfvars = readFileSync(tfvarsFile, "utf8");
  const account = /^\s*cloudflare_account_id\s*=\s*"([^"]+)"/m.exec(tfvars)?.[1];
  if (/^\s*(tuya_local_key|ntfy_token)\s*=/m.test(tfvars)) warn("terraform.tfvars contains a secret-looking value; it would be stored as a plain variable. Move it to the env file.");
  for (const [name, value] of [["TFVARS", tfvars], ["CLOUDFLARE_ACCOUNT_ID", account]]) {
    if (!value) skip(`${name}: nothing to set`);
    else if (dryRun) skip(`${name} would be set`);
    else {
      const r = gh(["variable", "set", name, "--repo", repo, "--body", value]);
      if (r.status === 0) ok(`${name} set`);
      else warn(`${name}: ${message(r)}`);
    }
  }
}

if (!["settings", "secrets", "all"].includes(command)) {
  console.error("usage: github-setup.mjs [settings|secrets|all] [--no-protect] [--dry-run] [--env FILE] [--tfvars FILE]");
  process.exit(2);
}
if (command === "settings" || command === "all") settings();
if (command === "secrets" || command === "all") secrets();
console.log("");

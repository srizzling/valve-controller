# CI/CD and GitHub

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

| Job | What it does |
| --- | --- |
| Worker | typecheck, tests, and the same bundle build Terraform deploys |
| Scripts | the Python tests for `tuya-login.py`, and a syntax check of the Node scripts |
| Terraform | `fmt`, `init -backend=false`, `validate` against the locked providers |
| Architecture diagram is current | warns (does not block) when the diagram is behind the code |
| `ci-ok` | one gate that fails if any of the above failed. Branch protection, if you turn it on, requires this check |
| Terraform plan / apply | `plan` on every run, `apply` only on `main`, one run at a time (the state has no locking) |

Every action is pinned to a commit. The plan and apply job needs the secrets and variables below and does nothing
until they exist: it prints which ones are missing and exits cleanly.

```sh
node scripts/github-setup.mjs secrets    # copies infra/.env and infra/terraform.tfvars into GitHub
node scripts/github-setup.mjs secrets --dry-run   # shows the names it would set, never the values
```

| Where | Name | Comes from |
| --- | --- | --- |
| secret | `CLOUDFLARE_API_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TF_VAR_healthchecks_api_key`, `TF_VAR_tuya_session`, `TF_VAR_ntfy_token` | `infra/.env` |
| variable | `TFVARS`, `CLOUDFLARE_ACCOUNT_ID` | `infra/terraform.tfvars` |

Anyone who can change a workflow on a branch can read these secrets when it runs, so keep the repository single-owner.
It is public, so workflows from outside contributors' pull requests wait for your approval and fork runs never receive
secrets. Branch protection is off, so a push to `main` deploys.

**Repository settings** are code too: `node scripts/github-setup.mjs settings` (safe to repeat) sets squash-only merges,
deletes merged branches, turns Dependabot alerts on and makes workflow tokens read-only. Branch protection is
optional and off by default: add `--protect` to require a pull request with a passing `ci-ok`, no force pushes, no
deletion and linear history (it needs GitHub Pro on the repo owner's account, or a public repository).

**Dependencies.** Dependabot alerts watch for known vulnerabilities. Renovate (`renovate.json`) opens the update PRs,
including the security ones it reads from those alerts, so Dependabot's own security PRs are switched off to avoid
duplicates. It covers the Worker's npm packages, the scripts' Python packages, Terraform providers and lock files and the
Actions pins. Dev tooling patches and Actions pins merge themselves once CI is green; everything that changes runtime
behaviour waits for you. Renovate runs as a GitHub App: install it once at <https://github.com/apps/renovate> and give it
this repository.

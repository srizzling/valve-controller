# CI/CD and GitHub

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

| Job | What it does |
| --- | --- |
| Worker | typecheck, tests, and the same bundle build Terraform deploys |
| Scripts | the Python tests for `tuya-login.py`, and a syntax check of the Node scripts |
| Terraform | `fmt`, `init -backend=false`, `validate` against the locked providers |
| Architecture diagram is current | warns (does not block) when the diagram is behind the code |
| `ci-ok` | one gate that fails if any of the above failed. Branch protection requires this check |
| Terraform plan / apply | `plan` on every run, `apply` only on `main`, one run at a time (the state has no locking) |

`.github/workflows/release-please.yml` is separate: it keeps the release pull request up to date (see [Releases](#releases)).

Every action is pinned to a commit. The plan and apply job needs the secrets and variables below and does nothing
until they exist: it prints which ones are missing and exits cleanly.

```sh
node scripts/github-setup.mjs secrets    # copies infra/.env and infra/terraform.tfvars into GitHub
node scripts/github-setup.mjs secrets --dry-run   # shows the names it would set, never the values
```

| Where | Name | Comes from |
| --- | --- | --- |
| secret | `CLOUDFLARE_API_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TF_VAR_healthchecks_api_key`, `TF_VAR_tuya_session`, `TF_VAR_ntfy_token`, `TF_VAR_anthropic_api_key` | `infra/.env` |
| variable | `TFVARS`, `CLOUDFLARE_ACCOUNT_ID` | `infra/terraform.tfvars` |

Anyone who can change a workflow on a branch can read these secrets when it runs, so keep the repository single-owner.
It is public, so workflows from outside contributors' pull requests wait for your approval and fork runs never receive
secrets. A push to `main` deploys, so `main` is protected (below).

**Repository settings** are code too: `node scripts/github-setup.mjs settings` (safe to repeat; `--dry-run` shows what it
would do). It sets:

- squash-only merges, merged branches deleted, auto-merge allowed
- `main` protected: a pull request with a passing `ci-ok`, a branch that is up to date, linear history, no force
  push, no deletion, conversations resolved. Admins are not forced through this, so you can still push in an emergency
  and GitHub records it. Set `enforce_admins` to `true` in the script to remove that escape hatch. `--no-protect` skips
  all of it. It needs a public repository or GitHub Pro.
- `v*` release tags that can be created but not moved or deleted
- workflow tokens that are read-only by default (Actions may open pull requests, for Release Please), and outside
  contributors' runs that wait for your approval
- an allow-list of actions (GitHub's own, `hashicorp/setup-terraform`, `googleapis/release-please-action`), every one
  pinned to a full commit SHA
- Dependabot alerts, secret scanning with push protection, private vulnerability reporting (see `SECURITY.md`) and
  CodeQL on the Worker, the scripts and the workflow files

If you add an action, add it to `ALLOWED_ACTIONS` in the script and run it again, or the workflow will be refused.

**Dependencies.** Dependabot alerts watch for known vulnerabilities. Renovate (`renovate.json`) opens the update PRs,
including the security ones it reads from those alerts, so Dependabot's own security PRs are switched off to avoid
duplicates. It covers the Worker's npm packages, the scripts' Python packages, Terraform providers and lock files and the
Actions pins. Dev tooling patches and Actions pins merge themselves once CI is green; everything that changes runtime
behaviour waits for you. Renovate runs as a GitHub App: install it once at <https://github.com/apps/renovate> and give it
this repository.

## Releases

[Release Please](https://github.com/googleapis/release-please) turns the commit titles on `main` into versions. Squash
merges use the pull request title as the commit title, so **write PR titles as conventional commits**:
`feat(schedule): ...` is a minor version, `fix(ui): ...` a patch, and a `!` after the type (`feat(api)!: ...`) or a
`BREAKING CHANGE:` footer is a breaking change. `docs`, `chore`, `ci` and `refactor` do not appear in the notes. While
the version is below 1.0 a breaking change bumps the minor version.

After each merge it opens or updates one pull request, "chore(main): release x.y.z", holding `CHANGELOG.md` and
`version.txt`. Merging that pull request creates the `vx.y.z` tag and the GitHub release. It does not deploy anything:
every merge to `main` is already deployed by the Terraform job, so a release is a labelled point in history. The first
one is 0.1.0 and its notes cover the whole history. Settings are in `release-please-config.json`.

**Merging the release pull request.** Release Please uses the built-in `GITHUB_TOKEN`, and a pull request opened with that
token does not start CI, so the release pull request can never pass the required `ci-ok` check. Merge it as an admin,
using the branch protection bypass (`enforce_admins` is off). The merge only adds `CHANGELOG.md`, `version.txt` and a
tag, so there is nothing for CI to check. This needs the repository setting that lets Actions create pull requests,
which `scripts/github-setup.mjs` turns on. If you want CI to run on the release pull request, give Release Please a
GitHub App token instead.

## How the Worker is locked down

- **Login.** Cloudflare Access sits in front of the UI and `/api`, and the Worker checks the Access token itself, so the
  workers.dev address (switched off) would not bypass it either. Only `/oauth/*` and `/google/*` skip Access, because
  Google's servers cannot log in. They are protected by the link password and signed tokens.
- **Content Security Policy.** The UI may run only its own script and stylesheet, load nothing from other origins, never
  be framed and never post forms. The same policy is in the `<meta>` tag of `worker/public/index.html` and in
  `worker/assets-headers.txt`, which Terraform deploys as the static files' headers. Keep the two in step. The Worker's
  own responses (`worker/src/security.ts`) get a stricter one, plus `nosniff`, no framing, no referrer, `no-store` and
  HSTS. `worker/test/security.test.ts` fails if the UI gains inline script, an inline `style` attribute or an
  external resource, which the policy would block.
- **Cross-site requests.** Writes to `/api` must come from the app's own origin (`hono/csrf`).

What a CSP cannot do here: the Access login page and its cookies belong to Cloudflare, and a stolen Access session still
works until it expires (24 hours).

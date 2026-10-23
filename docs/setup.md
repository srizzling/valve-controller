# Setup: infrastructure as code

`infra/` creates everything on Cloudflare and healthchecks.io. **GitHub Actions applies it** on every merge to `main`.

| Managed by Terraform | Resource |
| --- | --- |
| Worker, assets, bindings, secrets, Durable Object | `cloudflare_worker`, `_worker_version`, `_workers_deployment` |
| Schedule check every minute | `cloudflare_workers_cron_trigger` |
| UI hostname, workers.dev switched off | `cloudflare_workers_custom_domain`, `_workers_script_subdomain` |
| Zero Trust team address | `cloudflare_zero_trust_organization` |
| Login in front of the UI, bypass for Google paths | `cloudflare_zero_trust_access_application` (two) |
| Missed-run alert | `healthchecksio_check` |
| Generated secrets and the ntfy topic name | `random_*`, read back with `terraform output` |

All secrets live in one git-ignored file, `infra/.env` (see `infra/.env.example`). `make` loads it, and
`node scripts/github-setup.mjs secrets` copies it into GitHub when you are ready.

```sh
cd infra
cp .env.example .env                                 # delete the lines you do not use; put ONE broad token in CLOUDFLARE_API_TOKEN
                                                     # (Account API Tokens:Edit + Workers R2 Storage:Edit)
make setup                                           # one time: state bucket, bucket-scoped R2 keys (added to .env), backend.hcl, terraform.tfvars
make token                                           # creates the narrow token Terraform needs, saves it as CLOUDFLARE_API_TOKEN,
                                                     # keeps the broad one as CLOUDFLARE_SETUP_TOKEN
$EDITOR terraform.tfvars                             # zone, hostname, your email, timezone, coordinates
$EDITOR .env                                         # add TF_VAR_healthchecks_api_key
# get the valve login (see valve.md)
make init && make apply                              # builds the Worker bundle, then applies
```

## First deploy: two applies

The Durable Object class is created by a migration, and a Worker version cannot bind to a class that does not exist yet.
Terraform's provider has a one-step setting for this (`exports`), but v5.28 fails to convert it, so the first deploy
takes two applies, controlled by `durable_object_ready` in `terraform.tfvars`:

1. `durable_object_ready = false` (the default): deploys the Worker with the migration and no binding.
2. `durable_object_ready = true`: deploys a new version with the binding. Leave it `true` from then on.

Every apply after that is a single step, and CI uses the `true` setting because it reads `terraform.tfvars`. Only a
brand new Worker (a new `worker_name`) needs the two steps again.

`make token` gives Terraform only what it manages: Workers Scripts, Access apps and the Zero Trust organisation on the
account, and Zone Read, DNS and Workers Routes on your zone. Run it again with `--rotate`
(`node terraform-token.mjs --rotate`) after you add your domain and set `zone_name`, to narrow the zone permissions from
"all zones in the account" to that one zone. The broad setup token can create other tokens, so delete it in the
dashboard once you no longer need it (`make setup` and `make token` need it again for a rotation).

`make` uses `terraform` and the committed lock files are for it. OpenTofu works too (`make apply TF=tofu`) but rewrites
the lock files.

Still manual, because there is no API for them:

- **Activating Zero Trust, once.** Cloudflare's API refuses to create the organisation until you press "Enable Access"
  in the Zero Trust dashboard (pick the team name and the Free plan). After that, Terraform takes over the organisation:
  set `zero_trust_team` in `terraform.tfvars` to the team name you chose, then
  `terraform import cloudflare_zero_trust_organization.this <account_id>` (in `infra/`, with `.env` loaded).
- Creating the healthchecks.io account and its ntfy or email integration.
- The Tuya login (scanning the QR code with your phone).
- The Google Home developer console project. `terraform output google_home` prints every value to paste into it.
- Subscribing to the ntfy topic (`terraform output ntfy_topic`).

## State

Terraform state holds every secret (the Tuya login, signing key, passwords), so it is never committed. It lives in a
private Cloudflare R2 bucket, `valve-controller-tfstate`, through Terraform's S3 backend.

`make setup` does the one-time work (it is safe to run again):

1. creates the bucket;
2. creates R2 keys that can only read and write that bucket (the key id is the token id, the secret is the SHA-256 of the
   token value, as R2 expects) and saves them to `infra/.env` (mode 600, git-ignored; `make` loads it);
3. writes `backend.hcl` (git-ignored, it only holds your account id) and, if missing, `terraform.tfvars` with your
   account id filled in.

To replace the keys later (and revoke the old ones) run `node setup.mjs --rotate`. If creating keys is refused (the token
lacks permission), the script says so, and you can create them in the dashboard instead (R2 > Manage R2 API tokens >
Object Read & Write on that bucket) and put the two values in `infra/.env`.

On a new machine, `make setup` finds the bucket, mints a second set of keys for that machine (the first machine keeps
working) and rewrites `backend.hcl`. There is no state locking, so run one `apply` at a time.

Terraform is the source of truth for the Worker's variables and secrets. `worker/wrangler.jsonc` is only used for
`wrangler dev` and for building the bundle, so do not `wrangler deploy`: it would replace what Terraform set.

The Tuya login in state is only a first-time seed. The Worker keeps the live, rotating copy in its own storage and ignores the
seed unless it is newer, so applying Terraform never resets a working login. Once the Worker has signed in you can
**clear `TF_VAR_tuya_session`** in `infra/.env` and delete the `TF_VAR_tuya_session` GitHub secret, so the login (which
can control every device on your Tuya account) is no longer copied into Terraform state, CI or your laptop. Keep
`tuya_user_code` in `terraform.tfvars` (it is not a secret): it lets the UI's QR reconnect work even with no login saved.

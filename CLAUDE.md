# value-controller

Cycle-and-soak controller for a Tuya water valve. See README.md for the architecture and setup.

## Architecture diagram

`docs/architecture/architecture.json` is the source of the interactive diagram `architecture.html`.
After a change to `worker/src`, `worker/wrangler.jsonc`, or `infra/*.tf` is committed, a hook will ask
you to update it. Use the archify skill to edit the JSON, then run `node scripts/arch.mjs bump` (pins to HEAD and
re-verifies citations) or `node scripts/arch.mjs finalize`, and commit the JSON and HTML.
Never edit the HTML by hand.

## Infrastructure

`infra/` is one Terraform root, applied by CI on merge to main. Secrets live in the git-ignored `infra/.env`.
The Worker controls the valve through Tuya's cloud (`worker/src/tuya.ts`, `valve.ts`); there is nothing at home.
Never run `wrangler deploy`: Terraform owns the Worker. `scripts/github-setup.mjs` manages repo settings, branch
protection and Actions secrets. `scripts/tuya-login.py` creates the Tuya login the Worker uses.

## Environment

Node, Python, Terraform and `gh` come from `devenv.nix` (direnv loads it). Add any new tool there, not globally.

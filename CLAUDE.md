# value-controller

Cycle-and-soak controller for a Tuya water valve. See README.md for the architecture and setup.

## Architecture diagram

`docs/architecture/architecture.json` is the source of the interactive diagram `architecture.html`.
After a change to the agent, `worker/src`, `worker/wrangler.jsonc`, or `infra/*.tf` is committed, a hook will ask
you to update it. Use the archify skill to edit the JSON, then run `node scripts/arch.mjs bump` (pins to HEAD and
re-verifies citations) or `node scripts/arch.mjs finalize`, and commit the JSON and HTML.
Never edit the HTML by hand.

## Infrastructure

`infra/` (cloud, applied by CI on merge to main) and `infra/homelab/` (agent containers, applied by hand) are separate
Terraform roots. Secrets live in the git-ignored `infra/.env`. Never run `wrangler deploy`: Terraform owns the Worker.
`scripts/github-setup.mjs` manages repo settings, branch protection and Actions secrets.

<img src="assets/icon.svg" width="64" height="64" alt="">

# value-controller

Cycle-and-soak controller for a Tuya water valve, because the built-in one doesn't work.

Water for N minutes, soak for M, repeat. Scheduled runs are skipped when rain is forecast. Every run sends an ntfy
notification. You can drive it from a web UI or from Google Home.

```
 browser / Google Home ──▶ Cloudflare Worker ──▶ Cloudflare Tunnel ──▶ agent (homelab) ──LAN──▶ Tuya valve
                           │  Durable Object: cycle/soak timers
                           │  cron (every minute): schedule
                           ├─▶ Open-Meteo (rain forecast)
                           └─▶ ntfy
```

- `agent/` runs on the homelab next to the valve. It exposes three authenticated endpoints (`/status`,
  `/valve/open`, `/valve/close`) and talks to the valve over the LAN with tinytuya. Every open carries a duration
  and a local timer, so the valve closes by itself if the Worker or tunnel dies mid-run. It also closes the valve when
  it starts.
- `worker/` holds the UI, the schedule, the cycle/soak state machine (a Durable Object with alarms), the rain check,
  ntfy, and Google Home.

## Behaviour

- Settings (water minutes, soak minutes, number of cycles, start times, rain thresholds) live in the UI. A run
  snapshots them at start, so editing mid-run changes nothing until the next run.
- A run is `cycles` watering periods with a soak between each. It ends after the last watering period (no trailing soak).
- Rain check applies to **scheduled** runs only: skip if any hour in the lookahead window is at or above the
  probability threshold, or the forecast total reaches the mm threshold. If the forecast can't be fetched it waters
  anyway and says so in the notification. Starting from the UI or by voice always runs.
- If the agent can't be reached when a phase changes, it retries twice (30s apart), then aborts the run, tries to
  close the valve and sends a high-priority ntfy.

## Setup

### 1. Agent (homelab)

```sh
cd agent
cp .env.example .env     # fill in the Tuya device id, local key, IP, AGENT_TOKEN, TUNNEL_TOKEN
docker compose up -d
```

Get the device id and local key with `python -m tinytuya wizard` (needs a Tuya IoT platform project linked to your
app). Give the valve a fixed IP/DHCP reservation. Try `TUYA_VERSION` 3.3, 3.4 or 3.5 if it doesn't answer, and
check the switch data point (`TUYA_DP`, usually 1).

In Cloudflare Zero Trust, create a tunnel and point a public hostname (e.g. `valve-agent.example.com`) at
`http://agent:8080`.

### 2. Worker

```sh
cd worker
npm install
# edit wrangler.jsonc vars: AGENT_URL, TIMEZONE, LATITUDE, LONGITUDE, NTFY_TOPIC,
# and the two ACCESS_* values from step 3
npx wrangler secret put AGENT_TOKEN     # same value as the agent's AGENT_TOKEN
npx wrangler secret put SIGNING_KEY     # openssl rand -hex 32
npx wrangler secret put LINK_PASSWORD   # only used when linking Google Home
npx wrangler deploy
```

### 3. Lock it down with Cloudflare Access

The UI is reachable from anywhere, so it sits behind Cloudflare Access (login with your Google account or an emailed
code). The Worker also checks the Access token itself on every `/api/*` call, so a request that skips Access, for
example one sent straight to the `workers.dev` hostname, gets a 401/403. If the two `ACCESS_*` values are not set, `/api/*`
refuses everything (503) rather than leaving the valve open to the world.

1. Give the Worker a hostname you can protect: either a custom domain (Worker > Settings > Domains & Routes) or just
   the `workers.dev` one. In the same place, turn on **Cloudflare Access** for the Worker; that covers `workers.dev`
   and preview URLs too.
2. Zero Trust > Access > Applications > Add > Self-hosted, for the Worker hostname. Add an **Allow** policy for your
   own email (or Google identity).
3. Copy the application's **Audience (AUD) tag** into `ACCESS_AUD`, and your team domain
   (`<team>.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN`, both in `wrangler.jsonc`. Redeploy.
4. Only if you use Google Home: add a second self-hosted application for the paths `/oauth/*` and `/google/*` on the
   same hostname with a **Bypass** policy. Google's servers can't log in through Access. Those routes have their own
   auth: the link password for account linking, and signed tokens for fulfillment.

If the session expires while the page is open, requests fail and the page asks you to reload and sign in again.

### 4. Google Home (optional)

Smart Home Actions are free for personal use and don't need review while the project is in testing.

1. In the [Google Home developer console](https://console.home.google.com/) create a project and a cloud-to-cloud integration.
2. Account linking: client id and secret of your choosing, authorization URL `https://<worker>/oauth/authorize`,
   token URL `https://<worker>/oauth/token`.
3. Fulfillment URL: `https://<worker>/google/fulfillment`.
4. Set `GOOGLE_PROJECT_ID` in `wrangler.jsonc`, then
   `wrangler secret put GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and redeploy.
5. In the Google Home app: add device, "Works with Google", pick your project, enter `LINK_PASSWORD` when asked.

The valve appears as a sprinkler called "Garden water": "turn on / off the garden water" or "start / stop".

### Notifications

Subscribe to your `NTFY_TOPIC` in the ntfy app. Pick a hard-to-guess topic on the public server, or set `NTFY_URL` to
your own server (it must be reachable from Cloudflare) and add `NTFY_TOKEN`.

## Development

```sh
cd agent && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt && .venv/bin/python -m pytest
cd worker && npm install && npm test && npm run typecheck
```

For `wrangler dev`, copy `worker/.dev.vars.example` to `worker/.dev.vars`; it sets `DEV_BYPASS_ACCESS=true`, which must never be set in production. Minimum cycle and soak times of 0.1 minutes
are allowed so a whole run can be tried in under a minute against a fake agent.

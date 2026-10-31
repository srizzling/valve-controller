# The garden camera (optional)

A camera pointed at the valve and the plant gives the controller three things:

- **Leak checks.** About 30 seconds into each watering period, and a minute after each run ends, the Worker gets a
  photo and asks a Claude model whether water is going anywhere it should not (a hose that came off, a split fitting,
  spray where there is no emitter, water still flowing after the valve closed). If it says yes you get a priority 5 ntfy
  message with the photo attached. The Worker only alerts. It does not close the valve for you, because a photo is not
  proof and the cost of a wrong guess is a dry garden. Tap Stop in the UI.
- **A growth timelapse.** One photo a day, at midday by default and only in daylight, kept for about two years. The UI
  has a slider and a Play button, and shows the model's one-line note on how the plants look that day (new growth, wilting, yellowing).
- **A look on demand.** "Take a photo now" in the UI.

Without an Anthropic API key everything still works except the leak check: photos are kept and shown but not judged.
The default model is `claude-haiku-5-5`, the small one, so a check costs very little; set `camera_model` in `terraform.tfvars` to change it.

## How it fits together

Nothing at home is reachable from the internet, so the Worker cannot fetch a photo. Instead a small script on your
network asks the Worker every few seconds "do you want a photo?" and, when the answer is yes, takes one and posts it.
The Worker decides when (`worker/src/camera.ts`, `wantedFrame`); the script knows nothing about watering.

```
camera ── your network ── scripts/camera-pusher.mjs ──► Cloudflare Access ──► Worker ──► Claude (vision)
                                  polls GET /api/camera/wanted                  │  └──► ntfy (alert + photo)
                                  posts POST /api/camera/frame?kind=...         └──► Durable Object storage
```

The script signs in with a Cloudflare Access **service token**, which Terraform creates. The Worker lets that token reach
only `GET /api/camera/wanted` and `POST /api/camera/frame`; it cannot read the status or start the valve.

## Setup

1. Put an Anthropic API key in `infra/.env` as `TF_VAR_anthropic_api_key` (and copy it to GitHub with
   `node scripts/github-setup.mjs secrets`). Optional in `terraform.tfvars`: `camera_timelapse_hour`, `camera_model`, and `camera_scene`, a sentence telling the model what
   it is looking at, for example `potted lemon tree, mint, coriander and two roses on artificial grass`.
2. The service token needs a Terraform token permission it did not have before. Run `node terraform-token.mjs --rotate`
   in `infra/` (it adds **Access: Service Tokens Write**), update the `CLOUDFLARE_API_TOKEN` GitHub secret, then apply.
3. Read the token: `terraform output -raw camera_client_id` and `terraform output -raw camera_client_secret`.
4. Run the script on the homelab. It runs as the `camera-pusher` service in the homelab repo
   (`apps/camera-pusher`, a copy of `scripts/camera-pusher.mjs`). It needs only outbound HTTPS to the Worker and RTSP to
   go2rtc, so no ports are opened. Put `VALVE_URL`, `CAMERA_CLIENT_ID` and `CAMERA_CLIENT_SECRET` in the homelab's
   `.env` on the box and deploy. Anywhere else, plain Node 20 or later (with ffmpeg for an RTSP source) works too:

   ```sh
   export VALVE_URL=... CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... CAMERA_SOURCE=...
   node scripts/camera-pusher.mjs --once manual   # test: takes one photo, posts it, prints what the model saw
   node scripts/camera-pusher.mjs                 # then leave it running
   ```

   If the script stops asking for a photo for 15 minutes, the Worker sends an ntfy alert and the Camera card says so,
   because leak checks silently stop while it is down.

The photo appears in the UI's Camera card. The card stays hidden until the first photo arrives.

## Where the photo comes from

`CAMERA_SOURCE` is one of:

| Value | What happens |
| --- | --- |
| `rtsp://user:pass@host/path` | `ffmpeg` grabs one frame and shrinks it to 1280 px wide |
| `http://host/snapshot.jpg` | the script fetches the JPEG |
| `cmd:<shell command>` | the script runs the command and reads a JPEG from its output |

Photos must be JPEG and under 1.5 MB, so shrink them in the command if the camera's native size is bigger
(`ffmpeg ... -vf scale=1280:-2 -q:v 4`).

The eufyCam 3 on a HomeBase 3 works over RTSP, served by the HomeBase on port 554. Switch it on in the Eufy app under
the camera's Settings, General, Storage, RTSP/NAS. The app words this as NAS setup, but it only reveals a URL such as
`rtsp://<user>:<password>@<homebase-ip>/live0` with an account the HomeBase generates, and no NAS is needed. Until it is
switched on the HomeBase answers `404 Stream Not Found` on every path even though the port is open. Give the HomeBase a
fixed IP (a DHCP reservation). A battery camera wakes when the stream is pulled; a first frame took about 6 seconds.

In the homelab this goes through go2rtc, which holds the single connection to the HomeBase, so the script reads
`rtsp://go2rtc:8554/eufy` and the camera can also be watched in the browser.

## What the model is told

The prompt (in `camera.ts`) says what the valve should be doing (open or closed) and asks for a verdict through a forced
tool call, so the reply is always `{leak, summary, plant?}` or an error, never free text that could be misread as "no
leak". A frame that is dark or unclear is reported as no leak, with the reason in the summary. A model that cannot be
reached produces no alert, but the UI shows "Not checked" with the reason.

## Limits

- A slow drip or a small weep will not show up in a camera photo. This catches a burst or detached hose, not a loose
  fitting.
- Night and infrared make spray hard to see. The leak checks run whenever a run does, so a night run gets a weaker
  check.
- One alert per run and kind, so a hose that stays broken does not alert every cycle. The photo that triggered it is kept
  as "leak" until the next one.

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
Eufy camera ─ HomeBase ─ eufy-snapshot ─ scripts/camera-pusher.mjs ──► Cloudflare Access ──► Worker ──► Claude (vision)
  (battery)    (P2P)     (HTTP, homelab)   polls GET /api/camera/wanted                       │  └──► ntfy (alert + photo)
                                           posts POST /api/camera/frame?kind=...              └──► Durable Object storage
```

The script signs in with a Cloudflare Access **service token**, which Terraform creates. The Worker lets that token reach
only `GET /api/camera/wanted` and `POST /api/camera/frame`; it cannot read the status or start the valve.

## Setup

1. Put an Anthropic API key in `infra/.env` as `TF_VAR_anthropic_api_key` (and copy it to GitHub with
   `node scripts/github-setup.mjs secrets`). Optional in `terraform.tfvars`: `camera_timelapse_hour`, `camera_model`, and `camera_scene`, a sentence or two telling the model what
   it is looking at and where the valve is. Longer than 400 characters is cut off. One that fits this garden: `Courtyard seen from above, on
   artificial grass. Potted lemon tree, mint, coriander and two roses. The water valve is on the wall just right of the
   hot-water cylinder and a black drip pipe runs along the ground from it to each pot. Water should come out only at the
   drippers in the pots. A pipe joint spraying, a pipe end lying loose, or water running or pooling on the grass is a fault.`
2. The service token needs a Terraform token permission it did not have before. Run `node terraform-token.mjs --rotate`
   in `infra/` (it adds **Access: Service Tokens Write**), update the `CLOUDFLARE_API_TOKEN` GitHub secret, then apply.
3. Read the token: `terraform output -raw camera_client_id` and `terraform output -raw camera_client_secret`.
4. Run the script on the homelab. It runs as the `camera-pusher` service in the homelab repo (`apps/camera-pusher`, a copy
   of `scripts/camera-pusher.mjs`), reading its photo over HTTP from the `eufy-snapshot` service next to it (see below).
   It needs only outbound HTTPS to the Worker, so no ports are opened. Put `VALVE_URL`, `CAMERA_CLIENT_ID` and
   `CAMERA_CLIENT_SECRET` in the homelab's `.env` on the box and deploy. Anywhere else, plain Node 20 or later works too:

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

### The Eufy camera

A battery eufyCam 3 behind a HomeBase 3 does not give photos over RTSP, although the HomeBase listens on port 554 and the
Eufy app has an RTSP/NAS screen that shows a `rtsp://user:pass@homebase/live0` link:

- The stream at `/live0` exists only for a few seconds after the switch on that screen is flipped. The rest of the time
  every path answers `404 Stream Not Found`, with the camera awake or not, so nothing can pull a photo on demand.
- The username and password change every time that screen is opened.
- Community reports say battery cameras serve a stream only on motion or when it is explicitly requested, capped at about
  three minutes, and that some HomeBase 3 firmware broke RTSP altogether.

What works is what the community SDKs do: ask the HomeBase over its P2P channel to wake the camera and start a short live
burst, then decode one frame. In the homelab repo `apps/eufy-snapshot` does this with `@mega-yfue/eufy-sdk` (the successor
of the archived `eufy-security-ws`) and returns a JPEG at `http://eufy-snapshot:8080/snapshot.jpg`, shrunk to 1280 px
wide. A still takes about 6 seconds. It signs in to the Eufy cloud once (interactively, in case of a captcha or an emailed
code) and keeps the session on disk; `/healthz` reports `loggedIn`, and Gatus alerts if it goes false.

Use a second Eufy account the camera is shared with where you can, because a login from a new place can sign the phone app
out of the owner account. Give the HomeBase a fixed address (`scripts/unifi-reserve-ips.py` in the homelab repo does this
for the HomeBase there). The camera is infrared in the dark, and the camera's own night mode makes a wall close to the
lens a white blur.

### Other cameras

`CAMERA_SOURCE` is one of:

| Value | What happens |
| --- | --- |
| `http://host/snapshot.jpg` | the script fetches the JPEG |
| `rtsp://user:pass@host/path` | `ffmpeg` grabs one frame and shrinks it to 1280 px wide (needs ffmpeg) |
| `cmd:<shell command>` | the script runs the command and reads a JPEG from its output |

Photos must be JPEG and under 1.5 MB, so shrink them in the command if the camera's native size is bigger
(`ffmpeg ... -vf scale=1280:-2 -q:v 4`). A camera with an always-on RTSP stream needs nothing more than this.

## What the model is told

The prompt (in `camera.ts`) says what the valve should be doing (open or closed) and asks for a verdict through a forced
tool call, so the reply is always `{leak, summary, plant?}` or an error, never free text that could be misread as "no
leak". A frame that is dark or unclear is reported as no leak, with the reason in the summary. A model that cannot be
reached produces no alert, but the UI shows "Not checked" with the reason.

## Limits

- A slow drip or a small weep will not show up in a camera photo. This catches a burst or detached hose, not a loose
  fitting.
- Night and infrared make spray hard to see. The leak checks run whenever a run does, so a night run gets a weaker
  check. Tried at night with the real valve (5 minutes of drip, photos every 15 seconds): comparing a dry frame with frames
  from two minutes into the run showed no visible change at the valve, the pipe or the ground, and the black pipe is not
  visible in infrared either way. Judge the check by a daylight run, and do not rely on it for small drips.
- One alert per run and kind, so a hose that stays broken does not alert every cycle. The photo that triggered it is kept
  as "leak" until the next one.

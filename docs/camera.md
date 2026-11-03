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

## One plant at a time

`camera_pots` (in `terraform.tfvars`, as one JSON string) lists the pots in the frame. The Camera card then shows a button per
pot, and a button shows the photo cropped to that pot, for the latest photo and for every day of the timelapse. The crop is
done by the browser, so nothing extra is stored. Each pot has a `name`, a `where` that tells it apart from the others for the
model, and a `box` of `[x, y, width, height]` as fractions of the frame (0 to 1), so the box stays right if the photo size
changes. Read the numbers off a photo: x and y are the box's top left corner divided by the frame's width and height.

```
[{"name":"Mint","where":"small black pot, right of the lemon tree","box":[0.322,0.4,0.064,0.125]}]
```

The daily photo and a photo you ask for also get a one-line note per pot from the model (with the Anthropic key set). Leak
checks do not, to keep them quick. A box that is not inside the frame, or a repeated name, is dropped.

### Growth

Each day, after the daily photo, the Worker asks the model to compare it with an older daily photo and say how the plants have
changed: the newest photo that is at least a week old, or the oldest one once it is three days old. Before that there is
nothing to compare, so the Growth block does not appear. It shows an overall summary and, under a plant's button, a line on
that plant. It needs the Anthropic key. If the comparison fails the photo is still kept and the last summary stays. Light and
wet ground differ between photos, so a sentence about the light is the model being wrong, not the garden changing.

The boxes assume the camera does not move. If it is knocked or re-aimed, the crops drift until the boxes are redrawn.
Stills are 1280 pixels wide, so a pot a hundred pixels across is shown at about a third of that detail.

## What the model is told

The prompt (in `camera.ts`) says what the valve should be doing (open or closed) and asks for a verdict through a forced
tool call, so the reply is always `{leak, summary, plant?, pots?}` or an error, never free text that could be misread as "no
leak". A frame that is dark or unclear is reported as no leak, with the reason in the summary. A model that cannot be
reached produces no alert, but the UI shows "Not checked" with the reason.

## Asking Claude before a scheduled run

Off until you switch on "Ask Claude before each scheduled run" in Settings. It needs an Anthropic key and the camera script.

About six minutes before a scheduled start the Worker asks the script for one more frame (kind `precheck`). The script needs
no change: it already posts whatever kind the Worker asks for. When the run starts, a Claude model is shown the photo and
these facts:

- the planned number of cycles, your normal number, the most it may choose, and the schedule's own reasoning
- the weather now, today's evapotranspiration, the modelled soil moisture, and rain in the last and next 24 hours
- the last few runs and how long each watered
- what the camera said about each plant in the daily photo, and the weekly growth summary

It answers with a number of cycles and a reason. It reviews two kinds of run:

- **A run that is going ahead.** 0 skips it, a lower number waters less, and a higher number waters more, up to your
  "Never above" percentage of the normal cycles. A skip by Claude shows in the history as skipped for the weather, with a
  note starting "Claude:", and the alert has the photo attached.
- **A run the checks would skip for rain, wet soil or low demand.** Those come from a weather model on a grid of roughly
  10 km, which knows nothing about your pots. A pot under an eave or on a covered deck can be dry in a wet week. Claude
  can confirm the skip (it stays, with its reason added to the note, and the rain catch-up still happens) or overrule it
  and water between 1 cycle and your normal number. Overruling never waters more than normal, and sets no catch-up.

The frost and wind limits are never reviewed: a photo cannot tell it how cold it is, so those skips stand, and a rain skip
that arrives beside one is handled as before. A run you start by hand or by voice is never changed, and neither is the
rain catch-up later in the day, which has no pre-run frame. The check uses the same `camera_model` as the other checks.

When it cannot decide, the plan stands and the message says why: the model is down or returns something unusable, the key
is missing, or there is no recent photo. That means the planned cycles for a run that was going ahead, and the skip for one
that was not. With no pre-run frame (the script is down, say) it uses the latest daily photo if that is from today or
yesterday, and tells the model how old it is. Otherwise it does not ask.

At dawn and dusk the photo is often dark or infrared, so the model is told to keep the planned number when it cannot judge.
The weather numbers carry the decision then.

## Limits

- A slow drip or a small weep will not show up in a camera photo. This catches a burst or detached hose, not a loose
  fitting.
- Night and infrared make spray hard to see. The leak checks run whenever a run does, so a night run gets a weaker
  check. Tried at night with the real valve (5 minutes of drip, photos every 15 seconds): comparing a dry frame with frames
  from two minutes into the run showed no visible change at the valve, the pipe or the ground, and the black pipe is not
  visible in infrared either way. Judge the check by a daylight run, and do not rely on it for small drips.
- One alert per run and kind, so a hose that stays broken does not alert every cycle. The photo that triggered it is kept
  as "leak" until the next one.

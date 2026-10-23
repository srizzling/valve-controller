# Google Home and alerts

## Google Home (optional)

Smart Home Actions are free for personal use and don't need review while the project is in testing.

1. In the [Google Home developer console](https://console.home.google.com/) create a project and a cloud-to-cloud
   integration. `terraform output google_home` prints the client id, secret and the three URLs to enter.
2. Set `google_project_id` in `terraform.tfvars` and apply.
3. In the Google Home app: add device, "Works with Google", pick your project, enter `link_password` when asked
   (`terraform output -raw link_password`).

The valve appears as a sprinkler called "Garden water" (the closest device type Google offers): "turn on / off the garden water" or "start / stop".

## Alerts

ntfy messages tell you what happened. These catch what didn't:

| Alert | Where | Fires when |
| --- | --- | --- |
| Missed run | healthchecks.io | a scheduled run does not report in, so the schedule, Worker or Cloudflare is down |
| Cannot reach the valve | ntfy, 10 min before each scheduled start | Tuya's cloud did not answer |
| Tuya login expired | ntfy, same check, priority 5 | the saved login no longer refreshes: press the 🔑 chip in the UI and scan the QR code (or run `scripts/tuya-login.py`) |
| Valve offline | ntfy, same check | Tuya reports the valve offline: check its Wi-Fi and batteries |
| Low battery | ntfy, same check | the valve reports 20% or less |
| Open while idle | ntfy, same check, priority 5 | the valve is open with no run active |

Only **scheduled** runs report to healthchecks.io: `/start` when a run begins, a success ping when it finishes or is
skipped for rain (that is a run that did its job), and `/fail` when it errors. A run that starts and never finishes shows
up as a missed run too. If you switch scheduled runs off in the UI or go away, pause the check in healthchecks.io.

Subscribe to `terraform output ntfy_topic` in the ntfy app. The topic name is generated and hard to guess, which is the
only protection on the public ntfy server. Set `ntfy_url` to your own server (it must be reachable from Cloudflare) and
add `ntfy_token` to lock it down.

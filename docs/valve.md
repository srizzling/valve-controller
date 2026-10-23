# The valve and the Tuya login

The Worker controls the valve the way the Smart Life app does. `worker/src/tuya.ts` is a port of Tuya's MIT-licensed
`tuya-device-sharing-sdk` (the library behind Home Assistant's Tuya integration). It is tested against that library's own
output, and against an independent mock of Tuya's server.

- **Opening** sends the on/off command together with the valve's own **countdown** set to the run length plus 90 seconds,
  then asks the valve to confirm it reports open. If the Worker or Cloudflare ever stops, the valve closes itself. That is
  the failsafe. A valve with no countdown function runs without one (`tuya_countdown_code = ""`).
- **The one-hour supervisor** checks every minute, whether or not a run is active, for two things: the valve open for
  more than an hour (left on in the Smart Life app, say, or a close that never happened), and a run that has been going
  for more than an hour from its start, soaks included. Either way the Worker closes the valve, ends any run, records an
  error in the history and sends a priority 5 ntfy. If the close fails it alerts and tries again each minute. A run
  you configure to take longer than an hour will be stopped at the hour. The supervisor runs inside the Worker, so it
  does not help if Cloudflare or Tuya is down; the countdown does.
- **The login** is created once by scanning a QR code (below) and is kept in the Worker's private storage. Tuya rotates
  the refresh token each time it is used, so the Worker saves the new one every time and is the only thing that refreshes it.
- **If the login stops working** (revoked in the app, or unused for too long), the check ten minutes before each scheduled
  run sends a priority 5 ntfy saying so, and the valve chip in the UI turns into **🔑 Tuya login expired · reconnect**.
  Press it, scan the QR code with the Smart Life app (Me > the scan icon) and the Worker stores the new login itself. That
  needs no laptop, script or Terraform apply, so it works from anywhere (show the code on one screen, scan it with the
  phone). The login is checked against the valve first, so scanning from the wrong Smart Life account changes nothing.
  The script and Terraform route still works and is how the very first login is made.

This relies on an API Tuya does not document for third parties, and signs in with Home Assistant's registered client id
because Tuya has not registered one for this project. It is stable while Home Assistant depends on it, but Tuya could
change it. The alternative is a Tuya developer project (documented, but needs setup and periodic renewal).

**Getting the login.** Open the Smart Life app and copy your **User Code** (Me > settings gear > Account and Security >
User Code) into `infra/.env` as `TUYA_USER_CODE`. Then:

```sh
python scripts/tuya-login.py   # inside the devenv shell, which has the Python packages
```

It shows a QR code to scan in the app (Me > the scan icon), finds the valve (category `sfkzq`, or `--device <id>`),
prints what it can do, and saves the login to `infra/.env` and the valve's id and data point codes to
`infra/terraform.tfvars`. The login is **not** signed out: the Worker uses it. It can control every Tuya device on your
account until revoked (Smart Life app > Me > settings > Account and Security). It lives in `infra/.env` (mode 600),
Terraform state and the Worker's storage.

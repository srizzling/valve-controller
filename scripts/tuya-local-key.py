#!/usr/bin/env python3
"""Finds the Tuya water valve on the LAN and fetches its local key, with no Tuya developer project.

    scripts/.venv/bin/python scripts/tuya-local-key.py [--user-code CODE] [--device DEVICE_ID] [--dry-run]

You need your Smart Life (or Tuya Smart) app's User Code: Me > settings gear > Account and Security > User Code.
Put it in infra/.env as TUYA_USER_CODE, or pass --user-code.

It signs in the way Home Assistant's Tuya integration does: Tuya's official device-sharing SDK shows a QR code that you
scan in the app. That login uses Home Assistant's registered client id, because Tuya has not registered one for this
project. It is only used once, to read the local key.

What it does:
  1. listens on the LAN for Tuya devices (IP, device id, protocol version),
  2. shows a QR code, waits for you to scan it with the app,
  3. lists your devices and picks the valve (category "sfkzq", or the device you name with --device),
  4. saves its local key to infra/.env as TF_VAR_tuya_local_key and its id, IP and protocol to
     infra/homelab/terraform.tfvars. The key is never printed,
  5. signs out again, so no login to your Tuya account is left open. Nothing from the login is written to disk.
"""
import argparse
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / "infra" / ".env"
TFVARS = ROOT / "infra" / "homelab" / "terraform.tfvars"

# Home Assistant's registration with Tuya, the only one the QR login accepts for third-party tools.
CLIENT_ID = "HA_3y9q4ak7g4ephrvke"
SCHEMA = "haauthorize"
VALVE_CATEGORY = "sfkzq"  # Tuya's category code for a smart water valve
QR_WAIT_SECONDS = 180


def read_env(path: Path | None = None) -> dict[str, str]:
    path = path or ENV
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
            if m:
                values[m.group(1)] = m.group(2)
    return values


def upsert(path: Path, key: str, value: str, quote: bool) -> None:
    """Replace `key = ...` (or `key=...`) in place, or append it. Everything else in the file is kept."""
    text = path.read_text() if path.exists() else ""
    line = f'{key.ljust(14)} = "{value}"' if quote else f"{key}={value}"
    pattern = re.compile(rf"^{re.escape(key)}\s*=.*$", re.M)
    text = pattern.sub(lambda _: line, text, count=1) if pattern.search(text) else text.rstrip("\n") + ("\n" if text else "") + line + "\n"
    path.write_text(text)


def choose_valve(devices: list, lan: dict, wanted: str | None):
    """Returns (device, problem). Exactly one device must match, and it must have been seen on the LAN."""
    matches = [d for d in devices if (d.id == wanted if wanted else d.category == VALVE_CATEGORY)]
    if len(matches) != 1:
        return None, f"Could not pick exactly one valve ({len(matches)} matched). Re-run with --device <id> from the list above."
    if matches[0].id not in lan:
        return None, f"{matches[0].name} is on your account but was not seen on the LAN. Is it powered and on Wi-Fi?"
    return matches[0], None


def scan_lan() -> dict:
    import tinytuya

    found = tinytuya.deviceScan(verbose=False)  # {ip: {"gwId": ..., "version": ..., ...}}
    return {d["gwId"]: {"ip": ip, "version": str(d.get("version", ""))} for ip, d in found.items() if d.get("gwId")}


def sign_in(user_code: str, say=print):
    """QR login. Returns a Manager with the device list loaded, or None."""
    from tuya_sharing import LoginControl, Manager

    login = LoginControl()
    qr = login.qr_code(CLIENT_ID, SCHEMA, user_code)
    if not qr.get("success"):
        say(f"Tuya refused the login request: {qr.get('msg') or qr.get('code')}. Check the User Code (it is case sensitive).")
        return None
    token = qr["result"]["qrcode"]
    payload = f"tuyaSmart--qrLogin?token={token}"
    try:
        import qrcode

        code = qrcode.QRCode(border=1)
        code.add_data(payload)
        code.make()
        code.print_ascii(invert=True)
    except Exception:  # the QR picture is a convenience; the text below works with any QR generator
        pass
    say(f"\nScan this with the Smart Life app: Me > the scan icon at the top right.\n(Or turn this text into a QR code: {payload})")
    say(f"Waiting up to {QR_WAIT_SECONDS // 60} minutes...")
    deadline = time.time() + QR_WAIT_SECONDS
    while time.time() < deadline:
        ok, info = login.login_result(token, CLIENT_ID, user_code)
        if ok:
            manager = Manager(CLIENT_ID, user_code, info["terminal_id"], info["endpoint"], info)
            manager.update_device_cache()
            return manager
        time.sleep(3)
    say("Timed out waiting for the scan.")
    return None


def run(args, say=print) -> int:
    user_code = args.user_code or read_env().get("TUYA_USER_CODE")
    if not user_code:
        say("Add TUYA_USER_CODE to infra/.env (or pass --user-code). The app shows it under Me > settings gear > Account and Security > User Code.")
        return 1

    say("Listening for Tuya devices on the LAN (about 18 seconds)...")
    lan = scan_lan()
    for dev_id, d in lan.items():
        say(f"  LAN  {d['ip']:15} {dev_id}  protocol {d['version']}")
    if not lan:
        say("  none seen. Is this machine on the same network as the valve?")
        return 1

    manager = sign_in(user_code, say)
    if manager is None:
        return 1
    try:
        devices = list(manager.device_map.values())
        say("\nDevices on your Tuya account:")
        for d in devices:
            say(f"  {str(d.name):28} {d.id}  category={d.category}  {'on LAN' if d.id in lan else 'not seen on LAN'}")
        valve, problem = choose_valve(devices, lan, args.device)
        if problem:
            say(f"\n{problem}")
            return 1
        say(f"\nValve: {valve.name}  {valve.id}  at {lan[valve.id]['ip']}  protocol {lan[valve.id]['version']}")
        if args.dry_run:
            say("[dry run] nothing saved")
        else:
            upsert(ENV, "TF_VAR_tuya_local_key", valve.local_key, quote=False)
            upsert(TFVARS, "tuya_device_id", valve.id, quote=True)
            upsert(TFVARS, "tuya_ip", lan[valve.id]["ip"], quote=True)
            upsert(TFVARS, "tuya_version", lan[valve.id]["version"], quote=True)
            say(f"Saved the local key to {ENV.relative_to(ROOT)} (not shown) and id, IP and protocol to {TFVARS.relative_to(ROOT)}.")
        return 0
    finally:
        try:
            manager.unload()  # expire this login on Tuya's side
            say("Signed out of your Tuya account again.")
        except Exception as e:  # noqa: BLE001 - best effort; the login also expires by itself
            say(f"Could not sign out ({e}); it will expire on its own.")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user-code")
    ap.add_argument("--device", help="device id of the valve, if it should not be picked by category")
    ap.add_argument("--dry-run", action="store_true", help="show what would be saved, save nothing")
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Signs in to Tuya the way Home Assistant does, and hands the login to the Worker. No developer project needed.

    python scripts/tuya-login.py   (inside the devenv shell) [--user-code CODE] [--device DEVICE_ID] [--dry-run]

You need your Smart Life (or Tuya Smart) app's User Code: Me > settings gear > Account and Security > User Code.
Put it in infra/.env as TUYA_USER_CODE, or pass --user-code.

What it does:
  1. shows a QR code, waits for you to scan it with the app,
  2. finds the valve (category "sfkzq", or the device you name with --device) and prints what it can do,
  3. saves the login to infra/.env as TF_VAR_tuya_session, and the User Code, the valve's id and its data point
     codes to infra/terraform.tfvars, for Terraform to give to the Worker.

The login is NOT signed out afterwards: the Worker keeps using it, refreshing it as it goes. It can control every
Tuya device on your account until you revoke it (Smart Life app: Me > settings > Account and Security, or run this
script again, which replaces it). It is kept in infra/.env (mode 600, git-ignored), Terraform state and the Worker's
private storage. It uses Home Assistant's registered client id, because Tuya has not registered one for this project.
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / "infra" / ".env"
TFVARS = ROOT / "infra" / "terraform.tfvars"

# Home Assistant's registration with Tuya, the only one the QR login accepts for third-party tools.
CLIENT_ID = "HA_3y9q4ak7g4ephrvke"
SCHEMA = "haauthorize"
VALVE_CATEGORY = "sfkzq"  # Tuya's category code for a smart water valve
QR_WAIT_SECONDS = 180
SEED_FIELDS = ("terminal_id", "endpoint", "uid", "access_token", "refresh_token", "expire_time", "t")


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


def seed_json(info: dict, user_code: str) -> str:
    """The login in the shape the Worker reads. Tuya's own field names, plus the two the Worker needs to sign requests."""
    missing = [f for f in SEED_FIELDS if info.get(f) in (None, "")]
    if missing:
        raise ValueError(f"Tuya's login result is missing {missing}")
    seed = {"client_id": CLIENT_ID, "user_code": user_code, **{f: info[f] for f in SEED_FIELDS}}
    return json.dumps(seed, separators=(",", ":"))


def pick_valve(devices: list, wanted: str | None):
    """Returns (device, problem). Exactly one device must match."""
    matches = [d for d in devices if (d.id == wanted if wanted else d.category == VALVE_CATEGORY)]
    if len(matches) != 1:
        return None, f"Could not pick exactly one valve ({len(matches)} matched). Re-run with --device <id> from the list above."
    return matches[0], None


def data_point_codes(device) -> tuple[str, str]:
    """Best guess at the codes that open the valve and set its own auto-close timer, from what the device says it supports."""
    functions = getattr(device, "function", {}) or {}
    boolean = [c for c, f in functions.items() if getattr(f, "type", "") == "Boolean"]
    switch = next((c for c in boolean if re.fullmatch(r"switch(_1)?", c)), next((c for c in boolean if "switch" in c), ""))
    countdown = next((c for c in functions if "countdown" in c and getattr(functions[c], "type", "") == "Integer"), "")
    return switch, countdown


def sign_in(user_code: str, say=print):
    """QR login. Returns (manager, login_info), or (None, None)."""
    from tuya_sharing import LoginControl, Manager

    login = LoginControl()
    qr = login.qr_code(CLIENT_ID, SCHEMA, user_code)
    if not qr.get("success"):
        say(f"Tuya refused the login request: {qr.get('msg') or qr.get('code')}. Check the User Code (it is case sensitive).")
        return None, None
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
            return manager, info
        time.sleep(3)
    say("Timed out waiting for the scan.")
    return None, None


def describe(valve, say=print) -> None:
    say(f"\nValve: {valve.name}  ({valve.id})")
    say(f"  online = {valve.online}")
    status = getattr(valve, "status", {}) or {}
    say(f"  current state: {', '.join(f'{k}={v}' for k, v in sorted(status.items())) or '(none reported)'}")
    functions = getattr(valve, "function", {}) or {}
    say("  commands it accepts:")
    for code, f in sorted(functions.items()):
        say(f"    {code:24} {getattr(f, 'type', '')}  {getattr(f, 'values', '')}")


def run(args, say=print) -> int:
    user_code = args.user_code or read_env().get("TUYA_USER_CODE")
    if not user_code:
        say("Add TUYA_USER_CODE to infra/.env (or pass --user-code). The app shows it under Me > settings gear > Account and Security > User Code.")
        return 1
    manager, info = sign_in(user_code, say)
    if manager is None:
        return 1
    devices = list(manager.device_map.values())
    say("\nDevices on your Tuya account:")
    for d in devices:
        say(f"  {str(d.name):28} {d.id}  category={d.category}  online={d.online}")
    valve, problem = pick_valve(devices, args.device)
    if problem:
        say(f"\n{problem}")
        return 1
    describe(valve, say)
    switch, countdown = data_point_codes(valve)
    say(f"\nData points: switch = {switch or 'NOT FOUND'}, auto-close timer = {countdown or 'none (no valve-side failsafe)'}")
    if not switch:
        say("The valve exposes no on/off command I recognise, so nothing was saved. Send me the list above.")
        return 1
    if args.dry_run:
        say("[dry run] nothing saved. The login was not kept.")
        return 0
    upsert(ENV, "TF_VAR_tuya_session", seed_json(info, user_code), quote=False)
    upsert(TFVARS, "tuya_user_code", user_code, quote=True)
    upsert(TFVARS, "tuya_device_id", valve.id, quote=True)
    upsert(TFVARS, "tuya_switch_code", switch, quote=True)
    upsert(TFVARS, "tuya_countdown_code", countdown, quote=True)
    say(f"Saved the login to {ENV.relative_to(ROOT)} (not shown) and the valve's id and codes to {TFVARS.relative_to(ROOT)}.")
    say("The login stays open for the Worker to use. Apply Terraform soon: the Worker takes over refreshing it.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user-code")
    ap.add_argument("--device", help="device id of the valve, if it should not be picked by category")
    ap.add_argument("--dry-run", action="store_true", help="show what would be saved, save nothing")
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())

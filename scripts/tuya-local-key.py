#!/usr/bin/env python3
"""Finds the Tuya water valve on the LAN and fetches its local key from Tuya's cloud.

    agent/.venv/bin/python scripts/tuya-local-key.py [--device DEVICE_ID] [--dry-run]

Needs TUYA_API_KEY (Access ID) and TUYA_API_SECRET in infra/.env, from your project at https://iot.tuya.com
with your Smart Life app account linked to it.

You do not need to know your Tuya data center: every region is tried until one accepts the credentials.

What it does:
  1. listens on the LAN for Tuya devices (IP, device id, protocol version),
  2. finds which cloud region your project is in and lists your devices,
  3. picks the valve (category "sfkzq", or the device you name with --device),
  4. saves its local key to infra/.env as TF_VAR_tuya_local_key and its id, IP and protocol to
     infra/homelab/terraform.tfvars. The key is never printed.
"""
import argparse
import re
import sys
from pathlib import Path

import tinytuya

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / "infra" / ".env"
TFVARS = ROOT / "infra" / "homelab" / "terraform.tfvars"
# Australian accounts created before late 2025 are on Central Europe ("eu"); newer ones are on Singapore ("sg").
REGIONS = ["eu", "sg", "us", "us-e", "eu-w", "in", "cn"]
VALVE_CATEGORY = "sfkzq"  # Tuya's category code for a smart water valve


def read_env() -> dict[str, str]:
    values = {}
    if ENV.exists():
        for line in ENV.read_text().splitlines():
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
            if m:
                values[m.group(1)] = m.group(2)
    return values


def upsert(path: Path, key: str, value: str, quote: bool) -> None:
    """Replace `key = ...` (or `key=...`) in place, or append it. Everything else in the file is kept."""
    text = path.read_text() if path.exists() else ""
    rendered = f'"{value}"' if quote else value
    pattern = re.compile(rf"^{re.escape(key)}\s*=.*$", re.M)
    if quote:
        line = f"{key.ljust(14)} = {rendered}"
    else:
        line = f"{key}={rendered}"
    text = pattern.sub(lambda _: line, text, count=1) if pattern.search(text) else text.rstrip("\n") + ("\n" if text else "") + line + "\n"
    path.write_text(text)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", help="device id of the valve, if it should not be picked by category")
    ap.add_argument("--dry-run", action="store_true", help="show what would be saved, save nothing")
    args = ap.parse_args()

    env = read_env()
    key, secret = env.get("TUYA_API_KEY"), env.get("TUYA_API_SECRET")
    if not key or not secret:
        print("Add TUYA_API_KEY (Access ID) and TUYA_API_SECRET to infra/.env first. See the steps in the README.")
        return 1

    print("Listening for Tuya devices on the LAN (about 18 seconds)...")
    found = tinytuya.deviceScan(verbose=False)  # {ip: {"gwId": ..., "version": ..., ...}}
    lan = {d["gwId"]: {"ip": ip, "version": str(d.get("version", ""))} for ip, d in found.items() if d.get("gwId")}
    for dev_id, d in lan.items():
        print(f"  LAN  {d['ip']:15} {dev_id}  protocol {d['version']}")
    if not lan:
        print("  none seen. Is this machine on the same network as the valve?")
        return 1

    probe_id = args.device or next(iter(lan))
    cloud, region = None, None
    for r in REGIONS:
        c = tinytuya.Cloud(apiRegion=r, apiKey=key, apiSecret=secret, apiDeviceID=probe_id, configFile="/nonexistent/tinytuya.json")
        devices = c.getdevices(verbose=False)
        if isinstance(devices, list):
            cloud, region = devices, r
            print(f"Cloud region: {r}")
            break
        print(f"  region {r}: no ({(c.error or {}).get('Error') or (devices or {}).get('Error') or 'refused'})")
    if cloud is None:
        print(
            "\nNo region accepted the credentials. Check that:\n"
            "  - Access ID and Secret are from the project's Overview page (not the app),\n"
            "  - the project has the 'IoT Core' and 'Authorization Token Management' APIs authorized,\n"
            "  - your Smart Life account is linked (Devices > Link App Account),\n"
            "  - and the project's data center covers where your app account lives (select all when creating it)."
        )
        return 1

    print("\nDevices on your Tuya account:")
    for d in cloud:
        seen = "on LAN" if d.get("id") in lan else "not seen on LAN"
        print(f"  {str(d.get('name')):28} {d.get('id')}  category={d.get('category')}  {seen}")

    if args.device:
        valves = [d for d in cloud if d.get("id") == args.device]
    else:
        valves = [d for d in cloud if d.get("category") == VALVE_CATEGORY]
    if len(valves) != 1:
        print(f"\nCould not pick exactly one valve ({len(valves)} matched). Re-run with --device <id> from the list above.")
        return 1
    valve = valves[0]
    if valve["id"] not in lan:
        print(f"\n{valve.get('name')} is on your account but was not seen on the LAN. Is it powered and on Wi-Fi?")
        return 1
    local = lan[valve["id"]]
    print(f"\nValve: {valve.get('name')}  {valve['id']}  at {local['ip']}  protocol {local['version']}")

    if args.dry_run:
        print("[dry run] nothing saved")
        return 0
    upsert(ENV, "TF_VAR_tuya_local_key", valve["key"], quote=False)
    upsert(TFVARS, "tuya_device_id", valve["id"], quote=True)
    upsert(TFVARS, "tuya_ip", local["ip"], quote=True)
    upsert(TFVARS, "tuya_version", local["version"], quote=True)
    print(f"Saved the local key to {ENV.relative_to(ROOT)} (not shown) and id, IP and protocol to {TFVARS.relative_to(ROOT)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

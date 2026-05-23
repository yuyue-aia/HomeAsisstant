#!/usr/bin/env python3
# pyright: reportMissingImports=false
"""Demo: control a MiHome/Gosund plug via the downloaded API.

Usage examples:
  python3 demos/gosund-plug-control-demo.py --ip 192.168.0.27 --token <32-hex-token> status
  python3 demos/gosund-plug-control-demo.py --ip 192.168.0.27 --token <32-hex-token> on
  python3 demos/gosund-plug-control-demo.py --ip 192.168.0.27 --token <32-hex-token> --did s1 off
  python3 demos/gosund-plug-control-demo.py --ip 192.168.0.27 --token <32-hex-token> --did usb toggle

You can also set GOSUND_PLUG_IP and GOSUND_PLUG_TOKEN instead of passing args.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
API_DIR = REPO_ROOT / "Mihome-Gosund-Plug-API"
sys.path.insert(0, str(API_DIR))

try:
    from gosund_plug import GosundPlug
except ImportError as exc:
    raise SystemExit(
        "Cannot import GosundPlug. Make sure the API repo exists at "
        f"{API_DIR} and run: python3 -m pip install -r {API_DIR / 'requirements.txt'}"
    ) from exc

TOKEN_RE = re.compile(r"^[0-9a-fA-F]{32}$")
SWITCH_SIID_BY_DID = {
    "master": 2,
    "state": 2,
    "s4": 3,
    "s3": 4,
    "s2": 5,
    "s1": 6,
    "usb": 7,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Control a MiHome/Gosund plug switch.")
    parser.add_argument(
        "action",
        choices=("status", "on", "off", "toggle"),
        help="Action to run against the plug.",
    )
    parser.add_argument("--ip", default=os.getenv("GOSUND_PLUG_IP"), help="Plug LAN IP address.")
    parser.add_argument(
        "--token",
        default=os.getenv("GOSUND_PLUG_TOKEN"),
        help="32-character MiHome device token in hex.",
    )
    parser.add_argument(
        "-did",
        "--did",
        default="master",
        choices=SWITCH_SIID_BY_DID.keys(),
        help="Switch did to control. master/state=main switch, s1-s4=outlets, usb=USB switch.",
    )
    return parser.parse_args()


def require_config(ip: str | None, token: str | None) -> tuple[str, str]:
    if not ip:
        raise SystemExit("Missing plug IP. Pass --ip or set GOSUND_PLUG_IP.")
    if not token:
        raise SystemExit("Missing device token. Pass --token or set GOSUND_PLUG_TOKEN.")
    if not TOKEN_RE.fullmatch(token):
        raise SystemExit("Invalid token: expected a 32-character hex string.")
    return ip, token.lower()


def switch_status(plug: GosundPlug, did: str) -> bool:
    payload = {
        "id": 1,
        "method": "get_properties",
        "params": [{"did": did, "siid": SWITCH_SIID_BY_DID[did], "piid": 1}],
    }
    response = json.loads(plug.send(json.dumps(payload, separators=(",", ":")).encode()).decode())
    result = response["result"][0]
    if result.get("code") != 0:
        raise RuntimeError(f"Failed to read {did}: {response}")
    return result["value"]


def set_switch(plug: GosundPlug, did: str, value: bool) -> None:
    payload = {
        "id": 1,
        "method": "set_properties",
        "params": [{"did": did, "siid": SWITCH_SIID_BY_DID[did], "piid": 1, "value": value}],
    }
    response = json.loads(plug.send(json.dumps(payload, separators=(",", ":")).encode()).decode())
    result = response["result"][0]
    if result.get("code") != 0:
        raise RuntimeError(f"Failed to set {did}: {response}")


def main() -> None:
    args = parse_args()
    ip, token = require_config(args.ip, args.token)

    plug = GosundPlug(ip, token)
    did = args.did

    if args.action == "status":
        print(f"{did}: {'on' if switch_status(plug, did) else 'off'}")
    elif args.action == "on":
        set_switch(plug, did, True)
        print(f"{did}: switched on")
    elif args.action == "off":
        set_switch(plug, did, False)
        print(f"{did}: switched off")
    elif args.action == "toggle":
        if switch_status(plug, did):
            set_switch(plug, did, False)
            print(f"{did}: switched off")
        else:
            set_switch(plug, did, True)
            print(f"{did}: switched on")


if __name__ == "__main__":
    main()

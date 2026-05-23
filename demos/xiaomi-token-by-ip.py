#!/usr/bin/env python3
"""Find a Xiaomi device token by LAN IP using Xiaomi-cloud-tokens-extractor.

Default target IP: 192.168.0.27

Run:
  python3 demos/xiaomi-token-by-ip.py
  python3 demos/xiaomi-token-by-ip.py --ip 192.168.0.27 --server cn

The upstream extractor will ask you to log in by password or QR code.
The token is printed only to stdout and is not saved by this script.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
EXTRACTOR_DIR = REPO_ROOT / "Xiaomi-cloud-tokens-extractor"
EXTRACTOR = EXTRACTOR_DIR / "token_extractor.py"
TARGET_IP = "192.168.0.27"
SERVERS = {"", "cn", "de", "us", "ru", "tw", "sg", "in", "i2"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Get Xiaomi device token by local IP.")
    parser.add_argument("--ip", default=TARGET_IP, help=f"Device local IP. Default: {TARGET_IP}")
    parser.add_argument(
        "--server",
        default=os.getenv("XIAOMI_SERVER", ""),
        help="Xiaomi server region: cn/de/us/ru/tw/sg/in/i2. Empty means check all.",
    )
    parser.add_argument(
        "--username",
        default=os.getenv("XIAOMI_USERNAME"),
        help="Optional Xiaomi account username. Password/QR login is still handled by the extractor.",
    )
    return parser.parse_args()


def iter_devices(data: list[dict[str, Any]]):
    for server_item in data:
        server = server_item.get("server", "")
        for home in server_item.get("homes", []):
            home_id = home.get("home_id", "")
            for device in home.get("devices", []):
                yield server, home_id, device


def main() -> int:
    args = parse_args()

    if args.server not in SERVERS:
        print(f"Invalid --server: {args.server}", file=sys.stderr)
        return 2

    if not EXTRACTOR.exists():
        print(f"Missing extractor: {EXTRACTOR}", file=sys.stderr)
        print("Please clone https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor first.", file=sys.stderr)
        return 2

    with tempfile.NamedTemporaryFile(prefix="xiaomi-devices-", suffix=".json", delete=False) as fp:
        output_path = Path(fp.name)

    cmd = [sys.executable, str(EXTRACTOR), "-o", str(output_path)]
    if args.server:
        cmd += ["-s", args.server]
    if args.username:
        cmd += ["-u", args.username]

    try:
        result = subprocess.run(cmd, cwd=str(EXTRACTOR_DIR), check=False)
        if result.returncode != 0:
            print(f"Extractor failed with exit code {result.returncode}.", file=sys.stderr)
            return result.returncode

        data = json.loads(output_path.read_text())
        matches = [item for item in iter_devices(data) if item[2].get("localip") == args.ip]

        if not matches:
            print(f"No Xiaomi device found with IP {args.ip}.")
            print("Tip: rerun with empty --server to check all regions, and confirm the device is online in Mi Home.")
            return 1

        for server, home_id, device in matches:
            print("Matched Xiaomi device:")
            print(f"  SERVER: {server}")
            print(f"  HOME:   {home_id}")
            print(f"  NAME:   {device.get('name', '')}")
            print(f"  ID:     {device.get('did', '')}")
            print(f"  IP:     {device.get('localip', '')}")
            print(f"  MODEL:  {device.get('model', '')}")
            print(f"  TOKEN:  {device.get('token', '')}")
        return 0
    finally:
        try:
            output_path.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())

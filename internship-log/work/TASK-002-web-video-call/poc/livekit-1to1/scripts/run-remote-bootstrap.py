#!/usr/bin/env python3
"""Upload and run bootstrap-vpssieutoc.sh on a remote VPS via SSH."""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import paramiko

HOST = os.environ.get("VPS_HOST", "103.28.32.118")
USER = os.environ.get("VPS_USER", "root")
PASSWORD = os.environ.get("VPS_PASSWORD", "")
SCRIPT = Path(os.environ.get("REMOTE_SCRIPT", Path(__file__).with_name("bootstrap-vpssieutoc.sh")))
REMOTE = os.environ.get("REMOTE_PATH", "/root/bootstrap-livekit.sh")
MAX_SECONDS = int(os.environ.get("BOOTSTRAP_TIMEOUT", "1500"))


def main() -> int:
    if not PASSWORD:
        print("Set VPS_PASSWORD env var", file=sys.stderr)
        return 2
    if not SCRIPT.is_file():
        print(f"Missing {SCRIPT}", file=sys.stderr)
        return 2

    body = SCRIPT.read_text(encoding="utf-8")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Connecting to {USER}@{HOST} ...", flush=True)
    client.connect(
        HOST,
        port=22,
        username=USER,
        password=PASSWORD,
        timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )

    sftp = client.open_sftp()
    with sftp.file(REMOTE, "w") as fh:
        fh.write(body)
    sftp.chmod(REMOTE, 0o700)
    sftp.close()
    print(f"Uploaded {REMOTE}", flush=True)

    transport = client.get_transport()
    assert transport is not None
    channel = transport.open_session()
    channel.get_pty(width=200, height=50)
    channel.settimeout(30)
    channel.exec_command(f"bash {REMOTE}")

    start = time.time()
    while True:
        if channel.recv_ready():
            sys.stdout.write(channel.recv(65535).decode("utf-8", errors="replace"))
            sys.stdout.flush()
        if channel.recv_stderr_ready():
            sys.stderr.write(channel.recv_stderr(65535).decode("utf-8", errors="replace"))
            sys.stderr.flush()
        if channel.exit_status_ready():
            while channel.recv_ready():
                sys.stdout.write(channel.recv(65535).decode("utf-8", errors="replace"))
            while channel.recv_stderr_ready():
                sys.stderr.write(channel.recv_stderr(65535).decode("utf-8", errors="replace"))
            break
        if time.time() - start > MAX_SECONDS:
            print("\nTIMEOUT", flush=True)
            client.close()
            return 1
        time.sleep(0.25)

    code = channel.recv_exit_status()
    print(f"\nExit code: {code}", flush=True)
    client.close()
    return int(code)


if __name__ == "__main__":
    raise SystemExit(main())

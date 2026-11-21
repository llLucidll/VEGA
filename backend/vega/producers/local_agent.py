"""Local endpoint telemetry producer sending minimized metadata to POST /events."""

from __future__ import annotations

import argparse
import os
import socket
import subprocess
import time
from pathlib import Path
from uuid import uuid4

import httpx

from .synthetic import make_synthetic_event


def sample_process_payload() -> dict[str, object]:
    try:
        out = subprocess.check_output(
            ["ps", "-eo", "comm=", "--sort=-%cpu"],
            text=True,
            timeout=1.5,
        )
        top = [line.strip() for line in out.splitlines() if line.strip()][:5]
    except Exception:
        top = ["python3"]
    return {
        "host_role": "Local Workstation",
        "top_processes": top,
        "load_avg_1m": round(os.getloadavg()[0], 2),
    }


def sample_network_payload() -> dict[str, object]:
    tcp_established = 0
    try:
        with open("/proc/net/tcp", encoding="utf-8") as f:
            lines = f.readlines()[1:]
            tcp_established = sum(1 for line in lines if len(line.split()) > 3 and line.split()[3] == "01")
    except Exception:
        tcp_established = 0
    return {
        "host_role": "Local Workstation",
        "tcp_established": tcp_established,
        "internal": True,
    }


def sample_file_payload(watch_dir: Path) -> dict[str, object]:
    entries = 0
    latest_name = ""
    latest_mtime = 0.0
    try:
        for p in watch_dir.iterdir():
            if p.name.startswith(".") or p.name in {"node_modules", ".venv", "__pycache__"}:
                continue
            entries += 1
            st = p.stat()
            if st.st_mtime > latest_mtime:
                latest_mtime = st.st_mtime
                latest_name = p.name
    except Exception:
        pass
    return {
        "host_role": "Local Workstation",
        "watched_dir": watch_dir.name,
        "visible_entries": entries,
        "latest_entry": latest_name,
    }


def run_local_agent(
    *,
    ingest_url: str,
    source_id: str,
    run_id: str,
    interval_sec: float,
    watch_dir: Path,
    count: int | None = None,
) -> None:
    endpoint = f"{ingest_url.rstrip('/')}/events"
    sent = 0
    print(f"[vega-local-agent] source_id={source_id} run_id={run_id} -> {endpoint}")

    with httpx.Client(timeout=5.0) as client:
        while count is None or sent < count:
            samples = [
                ("process", sample_process_payload()),
                ("network", sample_network_payload()),
                ("file", sample_file_payload(watch_dir)),
            ]
            for channel, payload in samples:
                if count is not None and sent >= count:
                    break
                ev = make_synthetic_event(
                    run_id=run_id,
                    source_id=source_id,
                    channel=channel,  # type: ignore[arg-type]
                    payload=payload,
                )
                try:
                    res = client.post(endpoint, json=ev.model_dump(mode="json"))
                    if res.status_code == 201:
                        sid = res.json().get("stream_id")
                        print(f"  -> {channel:7s} {ev.event_id} (stream_id={sid})")
                    else:
                        print(f"  !! {channel:7s} HTTP {res.status_code}: {res.text}")
                except httpx.HTTPError as exc:
                    print(f"  !! {channel:7s} send failed: {exc}")
                sent += 1
            if count is None or sent < count:
                time.sleep(interval_sec)


def main() -> None:
    parser = argparse.ArgumentParser(description="VEGA local endpoint telemetry producer")
    parser.add_argument("--ingest-url", default="http://127.0.0.1:8000")
    parser.add_argument("--source-id", default=socket.gethostname())
    parser.add_argument("--run-id", default=f"local-{uuid4().hex[:6]}")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--watch-dir", default=".")
    parser.add_argument("--count", type=int, default=None)
    args = parser.parse_args()

    run_local_agent(
        ingest_url=args.ingest_url,
        source_id=args.source_id,
        run_id=args.run_id,
        interval_sec=args.interval,
        watch_dir=Path(args.watch_dir).resolve(),
        count=args.count,
    )


if __name__ == "__main__":
    main()

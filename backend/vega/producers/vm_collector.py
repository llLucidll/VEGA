#!/usr/bin/env python3
"""Zero-dependency VEGA endpoint collector for Linux VMs (stdlib only).

Monitors three minimized metadata channels and posts EventIn envelopes to POST /events:
  - file:    accesses in --secrets-dir and hidden archives created in /tmp
  - process: new shell commands tailed from ~/.bash_history + periodic process sample
  - network: outbound upload commands and non-ingest TCP connections via /proc/net/tcp
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def post_event(
    *,
    endpoint: str,
    run_id: str,
    source_id: str,
    channel: str,
    payload: dict[str, object],
) -> bool:
    body = json.dumps(
        {
            "schema_version": 1,
            "run_id": run_id,
            "event_id": f"evt-{uuid4().hex[:12]}",
            "source_id": source_id,
            "channel": channel,
            "event_time": utc_now_iso(),
            "payload": payload,
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=4.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"  -> [{channel:7s}] 201 stream_id={data.get('stream_id')} payload={payload}")
            return True
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"  !! [{channel:7s}] HTTP {exc.code}: {detail}")
    except Exception as exc:
        print(f"  !! [{channel:7s}] send failed: {exc}")
    return False


def decode_proc_net_tcp_addr(hex_addr: str) -> tuple[str, int]:
    ip_hex, port_hex = hex_addr.split(":")
    port = int(port_hex, 16)
    raw = bytes.fromhex(ip_hex)
    # /proc/net/tcp stores IPv4 in little-endian 32-bit order on x86_64
    ip = ".".join(str(b) for b in reversed(raw))
    return ip, port


def read_established_tcp() -> set[tuple[str, int]]:
    conns: set[tuple[str, int]] = set()
    try:
        with open("/proc/net/tcp", encoding="utf-8") as f:
            for line in f.readlines()[1:]:
                parts = line.split()
                if len(parts) < 4:
                    continue
                state = parts[3]
                if state not in {"01", "02"}:  # ESTABLISHED or SYN_SENT
                    continue
                ip, port = decode_proc_net_tcp_addr(parts[2])
                if ip != "0.0.0.0" and not ip.startswith("127."):
                    conns.add((ip, port))
    except OSError:
        pass
    return conns


def is_internal_ipv4(ip: str) -> bool:
    first, second, *_ = map(int, ip.split("."))
    return first == 10 or (first == 172 and 16 <= second <= 31) or (first == 192 and second == 168)


def sample_baseline_process() -> dict[str, object]:
    try:
        out = subprocess.check_output(
            ["ps", "-eo", "comm=", "--sort=-%cpu"],
            text=True,
            timeout=1.5,
        )
        top = [line.strip() for line in out.splitlines() if line.strip()][:5]
    except Exception:
        top = ["bash", "python3"]
    return {
        "host_role": "Linux VM Endpoint",
        "top_processes": top,
        "load_avg_1m": round(os.getloadavg()[0], 2),
    }


class VMTelemetryWatcher:
    def __init__(
        self,
        *,
        ingest_url: str,
        source_id: str,
        run_id: str,
        secrets_dir: Path,
        tmp_dir: Path,
        history_file: Path,
        service_log: Path | None = None,
    ) -> None:
        self.endpoint = f"{ingest_url.rstrip('/')}/events"
        parsed = urllib.parse.urlparse(ingest_url)
        self.ingest_host = parsed.hostname or "127.0.0.1"
        self.ingest_port = parsed.port or (443 if parsed.scheme == "https" else 80)

        self.source_id = source_id
        self.run_id = run_id
        self.secrets_dir = secrets_dir
        self.tmp_dir = tmp_dir
        self.history_file = history_file
        self.service_log = service_log

        self._secrets_atime: dict[str, float] = self._snapshot_dir_atime(secrets_dir)
        self._tmp_archives: dict[str, int] = self._snapshot_tmp_archives(tmp_dir)
        self._history_offset: int = self._initial_file_offset(history_file)
        self._service_log_offset: int = (
            self._initial_file_offset(service_log) if service_log is not None else 0
        )
        self._service_archive_meta: dict[str, dict[str, object]] = {}
        self._seen_tcp: set[tuple[str, int]] = read_established_tcp()
        self._last_secrets_alert = 0.0

    @staticmethod
    def _snapshot_dir_atime(directory: Path) -> dict[str, float]:
        snap: dict[str, float] = {}
        if not directory.exists():
            return snap
        try:
            for entry in directory.iterdir():
                if entry.is_file():
                    snap[str(entry)] = entry.stat().st_atime
        except OSError:
            pass
        return snap

    @staticmethod
    def _snapshot_tmp_archives(tmp_dir: Path) -> dict[str, int]:
        snap: dict[str, int] = {}
        if not tmp_dir.exists():
            return snap
        try:
            for entry in tmp_dir.iterdir():
                if entry.is_file() and entry.name.startswith(".") and (
                    entry.name.endswith(".tar.gz")
                    or entry.name.endswith(".tgz")
                    or entry.name.endswith(".zip")
                ):
                    snap[str(entry)] = entry.stat().st_size
        except OSError:
            pass
        return snap

    @staticmethod
    def _initial_file_offset(path: Path) -> int:
        try:
            return path.stat().st_size if path.exists() else 0
        except OSError:
            return 0

    def poll_once(self) -> list[tuple[str, dict[str, object]]]:
        emitted: list[tuple[str, dict[str, object]]] = []

        # 1. File channel: secrets directory reads (atime bump)
        current_atime = self._snapshot_dir_atime(self.secrets_dir)
        accessed = [
            path
            for path, atime in current_atime.items()
            if path not in self._secrets_atime or atime > self._secrets_atime[path]
        ]
        self._secrets_atime = current_atime
        now = time.monotonic()
        if accessed and (now - self._last_secrets_alert) > 2.0:
            self._last_secrets_alert = now
            emitted.append(
                (
                    "file",
                    {
                        "host_role": "Linux VM Endpoint",
                        "op": "read_burst",
                        "path": str(self.secrets_dir),
                        "file_count": len(accessed),
                        "sensitive_marker": "vault-export-manifest",
                    },
                )
            )

        # 1b. Service execution log (e.g. systemd backup jobs)
        for record in self._read_new_service_records():
            cmd = str(record.get("cmd") or "").strip()
            if not cmd:
                continue
            meta: dict[str, object] = {}
            for key in ("user", "unit", "source_dir", "dst_ip"):
                if record.get(key):
                    meta[key] = record[key]
            archive_path = record.get("archive_path")
            if isinstance(archive_path, str) and archive_path:
                self._service_archive_meta[archive_path] = dict(meta)
            proc_payload: dict[str, object] = {
                "host_role": "Linux VM Endpoint",
                "cmd": cmd,
                "parent": str(record.get("parent") or "systemd"),
                "source": "systemd_service",
            }
            proc_payload.update(meta)
            emitted.append(("process", proc_payload))
            net_payload = self._detect_upload_command(cmd)
            if net_payload is not None:
                net_payload.update(meta)
                emitted.append(("network", net_payload))

        # 2. File channel: hidden archive staging in /tmp
        current_archives = self._snapshot_tmp_archives(self.tmp_dir)
        for path, size in current_archives.items():
            prev_size = self._tmp_archives.get(path)
            if prev_size is None or size > prev_size:
                file_payload: dict[str, object] = {
                    "host_role": "Linux VM Endpoint",
                    "op": "create" if prev_size is None else "write",
                    "path": path,
                    "bytes": size,
                    "hidden_dotfile": True,
                }
                if path in self._service_archive_meta:
                    file_payload.update(self._service_archive_meta[path])
                emitted.append(("file", file_payload))
        self._tmp_archives = current_archives

        # 3. Process + Network channels: tail ~/.bash_history
        for cmd in self._read_new_history_lines():
            emitted.append(
                (
                    "process",
                    {
                        "host_role": "Linux VM Endpoint",
                        "cmd": cmd,
                        "parent": "bash",
                        "source": "bash_history",
                    },
                )
            )
            net_payload = self._detect_upload_command(cmd)
            if net_payload is not None:
                emitted.append(("network", net_payload))

        # 4. Network channel: new outbound TCP connections (excluding VEGA ingest itself)
        current_tcp = read_established_tcp()
        new_conns = current_tcp - self._seen_tcp
        self._seen_tcp = current_tcp
        for ip, port in sorted(new_conns):
            if ip == self.ingest_host and port == self.ingest_port:
                continue
            is_sink = port == 8443
            emitted.append(
                (
                    "network",
                    {
                        "host_role": "Linux VM Endpoint",
                        "dst": f"{ip}:{port}",
                        "proto": "TCP",
                        "internal": is_internal_ipv4(ip) and not is_sink,
                        "unapproved_egress": is_sink,
                    },
                )
            )

        return emitted

    def _read_new_history_lines(self) -> list[str]:
        if not self.history_file.exists():
            return []
        try:
            size = self.history_file.stat().st_size
            if size < self._history_offset:
                self._history_offset = 0
            if size == self._history_offset:
                return []
            with open(self.history_file, "r", encoding="utf-8", errors="replace") as f:
                f.seek(self._history_offset)
                chunk = f.read()
                self._history_offset = f.tell()
            return [line.strip() for line in chunk.splitlines() if line.strip() and not line.startswith("#")]
        except OSError:
            return []

    def _read_new_service_records(self) -> list[dict[str, object]]:
        if self.service_log is None or not self.service_log.exists():
            return []
        try:
            size = self.service_log.stat().st_size
            if size < self._service_log_offset:
                self._service_log_offset = 0
            if size == self._service_log_offset:
                return []
            with open(self.service_log, "r", encoding="utf-8", errors="replace") as f:
                f.seek(self._service_log_offset)
                chunk = f.read()
                self._service_log_offset = f.tell()
            records: list[dict[str, object]] = []
            for line in chunk.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    records.append(parsed)
            return records
        except OSError:
            return []

    def _detect_upload_command(self, cmd: str) -> dict[str, object] | None:
        if not re.search(r"\b(curl|scp|rsync|nc|ncat)\b", cmd):
            return None
        url_match = re.search(r"https?://([^\s/]+)(/[^\s]*)?", cmd)
        dst = url_match.group(1) if url_match else "external-target"
        path_match = re.search(r"@([^\s\"']+)", cmd)
        bytes_out = 0
        if path_match:
            p = Path(path_match.group(1))
            if p.exists() and p.is_file():
                bytes_out = p.stat().st_size
        is_exfil = (
            ":8443" in cmd
            or "exfil-sink" in cmd
            or "upload" in cmd
            or ".tar.gz" in cmd
            or ".tgz" in cmd
        )
        if not is_exfil:
            return None
        return {
            "host_role": "Linux VM Endpoint",
            "dst": dst,
            "proto": "HTTP",
            "bytes_out": bytes_out,
            "internal": False,
            "unapproved_egress": True,
            "cmd": cmd,
        }

    def run_forever(self, *, poll_interval: float = 0.35, heartbeat_interval: float = 4.0) -> None:
        print(
            f"[vega-vm-collector] source_id={self.source_id} run_id={self.run_id} "
            f"-> {self.endpoint}"
        )
        print(
            f"  watching secrets={self.secrets_dir} tmp={self.tmp_dir} "
            f"history={self.history_file}"
        )

        # Send initial registration heartbeat immediately
        post_event(
            endpoint=self.endpoint,
            run_id=self.run_id,
            source_id=self.source_id,
            channel="process",
            payload=sample_baseline_process(),
        )
        last_heartbeat = time.monotonic()

        while True:
            for channel, payload in self.poll_once():
                post_event(
                    endpoint=self.endpoint,
                    run_id=self.run_id,
                    source_id=self.source_id,
                    channel=channel,
                    payload=payload,
                )

            now = time.monotonic()
            if now - last_heartbeat >= heartbeat_interval:
                last_heartbeat = now
                post_event(
                    endpoint=self.endpoint,
                    run_id=self.run_id,
                    source_id=self.source_id,
                    channel="process",
                    payload=sample_baseline_process(),
                )

            time.sleep(poll_interval)


def main() -> None:
    parser = argparse.ArgumentParser(description="VEGA zero-dependency VM telemetry collector")
    parser.add_argument("--ingest-url", default="http://10.97.0.1:8000")
    parser.add_argument("--source-id", default=socket.gethostname())
    parser.add_argument("--run-id", default=f"vm-{uuid4().hex[:6]}")
    parser.add_argument("--secrets-dir", default="/srv/secrets/prod-keys")
    parser.add_argument("--tmp-dir", default="/tmp")
    parser.add_argument("--history-file", default=str(Path.home() / ".bash_history"))
    parser.add_argument("--service-log", default="/var/log/vega-backup.jsonl")
    parser.add_argument("--poll-interval", type=float, default=0.35)
    parser.add_argument("--heartbeat-interval", type=float, default=4.0)
    args = parser.parse_args()

    watcher = VMTelemetryWatcher(
        ingest_url=args.ingest_url,
        source_id=args.source_id,
        run_id=args.run_id,
        secrets_dir=Path(args.secrets_dir),
        tmp_dir=Path(args.tmp_dir),
        history_file=Path(args.history_file),
        service_log=Path(args.service_log) if args.service_log else None,
    )
    watcher.run_forever(
        poll_interval=args.poll_interval,
        heartbeat_interval=args.heartbeat_interval,
    )


if __name__ == "__main__":
    main()

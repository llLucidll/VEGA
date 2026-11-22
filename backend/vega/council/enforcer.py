"""Real and dry-run containment executors for Warden (Auth0, Vault, Multipass VM iptables)."""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol
from urllib.parse import quote

import httpx

from ..models import WardenActionType, WardenAuditEntry

LOG = logging.getLogger("vega.warden.enforcer")

_HOST_RE = re.compile(r"^vm-[a-z0-9-]+$")
_AUTH0_SUB_RE = re.compile(r"^auth0\|[a-zA-Z0-9_-]+$")
_AUTH0_DOMAIN_RE = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.auth0\.com$")
_BLOCKED_USERS_PATH = "/etc/vega-auth0-vault/blocked-users"
_VAULT_UNIT_PATH = "/etc/systemd/system/vega-auth0-vault.service"


def _now_ts() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3] + "Z"


def _audit(actor: str, message: str, status: str = "ok") -> WardenAuditEntry:
    return WardenAuditEntry(
        id=f"aud-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{id(message) % 10000}",
        timestamp=_now_ts(),
        actor=actor,  # type: ignore[arg-type]
        message=message,
        status=status,  # type: ignore[arg-type]
    )


@dataclass
class ExecutionResult:
    succeeded: bool
    entries: list[WardenAuditEntry]
    isolated_hosts: list[str]
    revoked_subjects: list[str]


class ContainmentExecutor(Protocol):
    dry_run: bool

    async def execute(
        self,
        action_type: WardenActionType,
        hosts: list[str],
    ) -> ExecutionResult: ...

    async def release_all(self, hosts: list[str]) -> list[WardenAuditEntry]: ...


class DryRunContainmentExecutor:
    """Simulated executor used in tests or when VEGA_WARDEN_DRY_RUN=true."""

    dry_run: bool = True

    def __init__(self, vm_subjects: dict[str, str] | None = None) -> None:
        self.vm_subjects = dict(vm_subjects or {})

    async def execute(
        self,
        action_type: WardenActionType,
        hosts: list[str],
    ) -> ExecutionResult:
        entries: list[WardenAuditEntry] = []
        isolated: list[str] = []
        revoked: list[str] = []
        for host in hosts:
            if action_type in ("revoke_credentials", "quarantine_and_revoke"):
                sub = self.vm_subjects.get(host, f"subject:{host}")
                revoked.append(sub)
                entries.append(
                    _audit(
                        "WARDEN",
                        f"[DRY-RUN] [{host}] Would block {sub} in Vault and Auth0 Management API.",
                        "ok",
                    )
                )
            if action_type in ("quarantine_host", "quarantine_and_revoke"):
                isolated.append(host)
                entries.append(
                    _audit(
                        "WARDEN",
                        f"[DRY-RUN] [{host}] Would apply VEGA_QUARANTINE egress isolation.",
                        "ok",
                    )
                )
        return ExecutionResult(
            succeeded=True,
            entries=entries,
            isolated_hosts=isolated,
            revoked_subjects=revoked,
        )

    async def release_all(self, hosts: list[str]) -> list[WardenAuditEntry]:
        return [
            _audit("WARDEN", f"[DRY-RUN] Released containment state for {', '.join(hosts) or 'none'}.", "info")
        ]


class LiveContainmentExecutor:
    """Executes real containment on Multipass VMs, local Vault, and Auth0 Management API."""

    dry_run: bool = False

    def __init__(
        self,
        *,
        auth0_domain: str,
        auth0_client_id: str,
        auth0_client_secret: str,
        vm_subjects: dict[str, str],
        telemetry_host: str = "10.97.0.1",
        command_timeout: float = 15.0,
    ) -> None:
        self.auth0_domain = auth0_domain.strip()
        self.auth0_client_id = auth0_client_id.strip()
        self.auth0_client_secret = auth0_client_secret.strip()
        self.vm_subjects = dict(vm_subjects)
        self.telemetry_host = telemetry_host.strip()
        self.command_timeout = command_timeout
        self._revoked_subjects: set[str] = set()
        self._quarantined_hosts: set[str] = set()

    async def _run_multipass(
        self,
        host: str,
        args: list[str],
        *,
        stdin_text: str | None = None,
    ) -> tuple[int, str, str]:
        if not _HOST_RE.fullmatch(host):
            raise ValueError(f"Refusing unsafe host identifier: {host!r}")
        proc = await asyncio.create_subprocess_exec(
            "multipass",
            "exec",
            host,
            "--",
            *args,
            stdin=asyncio.subprocess.PIPE if stdin_text is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(stdin_text.encode() if stdin_text is not None else None),
                timeout=self.command_timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise TimeoutError(f"multipass exec timed out on {host}") from None
        return (
            proc.returncode or 0,
            stdout_b.decode("utf-8", errors="replace").strip(),
            stderr_b.decode("utf-8", errors="replace").strip(),
        )

    async def _resolve_vm_subject(self, host: str) -> str | None:
        if host in self.vm_subjects and _AUTH0_SUB_RE.fullmatch(self.vm_subjects[host]):
            return self.vm_subjects[host]
        rc, out, _ = await self._run_multipass(
            host,
            ["grep", "-oE", r"auth0\|[a-zA-Z0-9_-]+", _VAULT_UNIT_PATH],
        )
        if rc == 0 and out:
            sub = out.splitlines()[0].strip()
            if _AUTH0_SUB_RE.fullmatch(sub):
                self.vm_subjects[host] = sub
                return sub
        return None

    async def _block_vault_user(self, host: str, user_id: str) -> None:
        if not _AUTH0_SUB_RE.fullmatch(user_id):
            raise ValueError(f"Invalid Auth0 subject: {user_id!r}")
        script = (
            "from pathlib import Path; import sys; "
            "p = Path(sys.argv[1]); sub = sys.argv[2]; "
            "lines = [l.strip() for l in p.read_text().splitlines() if l.strip()] if p.exists() else []; "
            "lines.append(sub) if sub not in lines else None; "
            "f = p.open('w'); f.write('\\n'.join(lines) + '\\n'); f.close()"
        )
        rc, _, err = await self._run_multipass(
            host,
            ["sudo", "-n", "python3", "-c", script, _BLOCKED_USERS_PATH, user_id],
        )
        if rc != 0:
            raise RuntimeError(f"Vault block failed on {host}: {err or f'exit {rc}'}")

    async def _clear_vault_blocked_users(self, host: str) -> None:
        script = (
            "from pathlib import Path; import sys; "
            "p = Path(sys.argv[1]); "
            "f = p.open('w') if p.exists() else None; "
            "(f.write(''), f.close()) if f else None"
        )
        rc, _, err = await self._run_multipass(
            host,
            ["sudo", "-n", "python3", "-c", script, _BLOCKED_USERS_PATH],
        )
        if rc != 0:
            raise RuntimeError(f"Vault unblock failed on {host}: {err or f'exit {rc}'}")

    async def _get_auth0_token(self, client: httpx.AsyncClient) -> str:
        if not _AUTH0_DOMAIN_RE.fullmatch(self.auth0_domain):
            raise ValueError(f"Invalid Auth0 domain: {self.auth0_domain!r}")
        issuer = f"https://{self.auth0_domain}"
        resp = await client.post(
            f"{issuer}/oauth/token",
            json={
                "grant_type": "client_credentials",
                "client_id": self.auth0_client_id,
                "client_secret": self.auth0_client_secret,
                "audience": f"{issuer}/api/v2/",
                "scope": "update:users",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        token = data.get("access_token")
        if not token:
            raise RuntimeError("Auth0 did not return an access_token")
        return str(token)

    async def _set_auth0_blocked(self, user_id: str, *, blocked: bool) -> None:
        if not _AUTH0_SUB_RE.fullmatch(user_id):
            raise ValueError(f"Invalid Auth0 subject: {user_id!r}")
        issuer = f"https://{self.auth0_domain}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            token = await self._get_auth0_token(client)
            resp = await client.patch(
                f"{issuer}/api/v2/users/{quote(user_id, safe='')}",
                json={"blocked": blocked},
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
            body = resp.json()
            if body.get("user_id") != user_id or body.get("blocked") is not blocked:
                raise RuntimeError(f"Auth0 did not confirm blocked={blocked} for {user_id}")

    async def _ensure_conntrack(self, host: str) -> None:
        # Register nf_conntrack hooks in a prior SSH session so the quarantine
        # session's TCP handshake is tracked as ESTABLISHED before VEGA_QUARANTINE activates.
        script = (
            "iptables -C OUTPUT -m conntrack --ctstate NEW -j RETURN 2>/dev/null "
            "|| iptables -A OUTPUT -m conntrack --ctstate NEW -j RETURN"
        )
        rc, _, err = await self._run_multipass(host, ["sudo", "-n", "bash", "-c", script])
        if rc != 0:
            raise RuntimeError(f"conntrack warmup failed on {host}: {err or f'exit {rc}'}")

    async def _apply_vm_quarantine(self, host: str) -> None:
        script = r"""set -euo pipefail
telemetry_host=$1
# SSH_CONNECTION is set by the guest sshd: client IP/port then guest IP/port.
if ! ssh_reply=$(python3 -c '
from ipaddress import IPv4Address
import sys
peer, peer_port, guest, guest_port = sys.argv[1].split()
if not all(p.isascii() and p.isdecimal() and 0 < int(p) <= 65535 for p in (peer_port, guest_port)):
    sys.exit(1)
print(IPv4Address(peer), IPv4Address(guest), int(guest_port))
' "${2:-}" 2>/dev/null); then
  echo 'Missing or invalid IPv4 Multipass SSH connection; quarantine unchanged.' >&2
  exit 1
fi
read -r ssh_peer ssh_guest ssh_port <<< "$ssh_reply"
iptables -N VEGA_QUARANTINE 2>/dev/null || true
iptables -F VEGA_QUARANTINE
iptables -A VEGA_QUARANTINE -o lo -j ACCEPT
iptables -A VEGA_QUARANTINE -d "$telemetry_host" -p tcp --dport 8001 -j ACCEPT
iptables -A VEGA_QUARANTINE -d "$telemetry_host" -p tcp --dport 8000 -j ACCEPT
# Keep only replies to inbound SSH from the management peer, not guest-initiated flows.
iptables -A VEGA_QUARANTINE -s "$ssh_guest/32" -d "$ssh_peer/32" -p tcp --sport "$ssh_port" \
  -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j ACCEPT
iptables -A VEGA_QUARANTINE -p udp --dport 53 -j DROP
iptables -A VEGA_QUARANTINE -p tcp --dport 53 -j DROP
iptables -A VEGA_QUARANTINE -j DROP
if ! iptables -C OUTPUT -j VEGA_QUARANTINE 2>/dev/null; then
  iptables -I OUTPUT 1 -j VEGA_QUARANTINE
fi
pkill -u ubuntu -f 'curl.*8443|tar -czf /tmp/\.cache-bundle' || true
"""
        rc, _, err = await self._run_multipass(
            host,
            [
                "bash", "-c", 'exec sudo -n bash -s -- "$1" "${SSH_CONNECTION:-}"',
                "bash", self.telemetry_host,
            ],
            stdin_text=script,
        )
        if rc != 0:
            raise RuntimeError(f"iptables quarantine failed on {host}: {err or f'exit {rc}'}")

    async def _remove_vm_quarantine(self, host: str) -> None:
        script = """set -euo pipefail
while iptables -C OUTPUT -j VEGA_QUARANTINE 2>/dev/null; do
  iptables -D OUTPUT -j VEGA_QUARANTINE
done
while iptables -C OUTPUT -m conntrack --ctstate NEW -j RETURN 2>/dev/null; do
  iptables -D OUTPUT -m conntrack --ctstate NEW -j RETURN
done
iptables -F VEGA_QUARANTINE 2>/dev/null || true
iptables -X VEGA_QUARANTINE 2>/dev/null || true
"""
        rc, _, err = await self._run_multipass(
            host,
            ["sudo", "-n", "bash", "-s"],
            stdin_text=script,
        )
        if rc != 0:
            raise RuntimeError(f"iptables release failed on {host}: {err or f'exit {rc}'}")

    async def execute(
        self,
        action_type: WardenActionType,
        hosts: list[str],
    ) -> ExecutionResult:
        entries: list[WardenAuditEntry] = []
        isolated: list[str] = []
        revoked: list[str] = []
        all_ok = True

        for host in hosts:
            if action_type in ("revoke_credentials", "quarantine_and_revoke"):
                try:
                    user_id = await self._resolve_vm_subject(host)
                    if user_id is None:
                        entries.append(
                            _audit(
                                "WARDEN",
                                f"[{host}] No enrolled Auth0 subject found for Vault; skipping credential block.",
                                "warn",
                            )
                        )
                    else:
                        await self._block_vault_user(host, user_id)
                        self._revoked_subjects.add(user_id)
                        revoked.append(user_id)
                        entries.append(
                            _audit(
                                "WARDEN",
                                f"[{host}] Blocked {user_id} in local Vault ({_BLOCKED_USERS_PATH}); active tokens now return 403.",
                                "ok",
                            )
                        )
                        if self.auth0_client_id and self.auth0_client_secret:
                            await self._set_auth0_blocked(user_id, blocked=True)
                            entries.append(
                                _audit(
                                    "WARDEN",
                                    f"[{host}] Blocked Auth0 account {user_id} via Management API.",
                                    "ok",
                                )
                            )
                        else:
                            entries.append(
                                _audit(
                                    "WARDEN",
                                    f"[{host}] Auth0 Management API skipped (AUTH0_WARDEN_CLIENT_ID not set); local Vault block active.",
                                    "warn",
                                )
                            )
                except Exception as exc:  # noqa: BLE001
                    all_ok = False
                    LOG.exception("Credential revocation failed on %s", host)
                    entries.append(
                        _audit("WARDEN", f"[{host}] Credential revocation failed: {exc}", "critical")
                    )

            if action_type in ("quarantine_host", "quarantine_and_revoke"):
                try:
                    await self._ensure_conntrack(host)
                    await self._apply_vm_quarantine(host)
                    self._quarantined_hosts.add(host)
                    isolated.append(host)
                    entries.append(
                        _audit(
                            "WARDEN",
                            f"[{host}] Applied iptables VEGA_QUARANTINE egress isolation (telemetry preserved, exfil/external egress dropped).",
                            "ok",
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    all_ok = False
                    LOG.exception("Host quarantine failed on %s", host)
                    entries.append(
                        _audit("WARDEN", f"[{host}] Host quarantine failed: {exc}", "critical")
                    )

        return ExecutionResult(
            succeeded=all_ok and bool(isolated or revoked),
            entries=entries,
            isolated_hosts=isolated,
            revoked_subjects=revoked,
        )

    async def release_all(self, hosts: list[str]) -> list[WardenAuditEntry]:
        entries: list[WardenAuditEntry] = []
        target_hosts = sorted(set(hosts) | self._quarantined_hosts)
        for host in target_hosts:
            if not _HOST_RE.fullmatch(host):
                continue
            try:
                await self._remove_vm_quarantine(host)
                self._quarantined_hosts.discard(host)
                await self._clear_vault_blocked_users(host)
                entries.append(
                    _audit("WARDEN", f"[{host}] Cleared VEGA_QUARANTINE and Vault blocked-users.", "info")
                )
            except Exception as exc:  # noqa: BLE001
                LOG.warning("Failed to release %s: %s", host, exc)
                entries.append(_audit("WARDEN", f"[{host}] Release warning: {exc}", "warn"))

        if self.auth0_client_id and self.auth0_client_secret:
            for user_id in sorted(self._revoked_subjects):
                try:
                    await self._set_auth0_blocked(user_id, blocked=False)
                    self._revoked_subjects.discard(user_id)
                    entries.append(
                        _audit("WARDEN", f"Unblocked Auth0 account {user_id} on reset.", "info")
                    )
                except Exception as exc:  # noqa: BLE001
                    LOG.warning("Failed to unblock Auth0 user %s: %s", user_id, exc)
                    entries.append(_audit("WARDEN", f"Auth0 unblock warning for {user_id}: {exc}", "warn"))
        return entries

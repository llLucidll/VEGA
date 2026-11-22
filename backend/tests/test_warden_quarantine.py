"""Exercise the quarantine shell script with fake guest commands; never touch a VM."""

import os
import subprocess

import pytest

from vega.council.enforcer import LiveContainmentExecutor


@pytest.fixture
def quarantine_guest(tmp_path, monkeypatch):
    executor = LiveContainmentExecutor(
        auth0_domain="", auth0_client_id="", auth0_client_secret="", vm_subjects={},
    )
    log = tmp_path / "firewall.log"
    log.touch()
    guest_env = {"PATH": f"{tmp_path}:{os.defpath}", "FIREWALL_LOG": str(log)}
    for name, stub in {
        "sudo": 'set -eu\n[[ "$1" == -n ]]\nshift\nunset SSH_CONNECTION\nexec "$@"',
        "iptables": 'printf "%s\\n" "$*" >> "$FIREWALL_LOG"\n[[ "$1" != -C ]]',
        "pkill": "exit 1",
    }.items():
        command = tmp_path / name
        command.write_text(f"#!/bin/bash\n{stub}\n")
        command.chmod(0o700)

    async def run_multipass(host, args, *, stdin_text=None):
        assert host == "vm-a"
        result = subprocess.run(
            args, input=stdin_text, text=True, capture_output=True, env=guest_env, timeout=5,
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()

    monkeypatch.setattr(executor, "_run_multipass", run_multipass)
    return executor, guest_env, log


async def test_quarantine_keeps_only_reply_traffic_for_multipass_ssh(quarantine_guest):
    executor, guest_env, log = quarantine_guest
    guest_env["SSH_CONNECTION"] = "192.0.2.10 50954 192.0.2.11 22"
    await executor._apply_vm_quarantine("vm-a")
    rules = log.read_text().splitlines()
    ssh_reply = (
        "-A VEGA_QUARANTINE -s 192.0.2.11/32 -d 192.0.2.10/32 -p tcp --sport 22 "
        "-m conntrack --ctstate ESTABLISHED --ctdir REPLY -j ACCEPT"
    )
    assert [rule for rule in rules if "conntrack" in rule] == [ssh_reply]
    assert rules.index(ssh_reply) < rules.index("-A VEGA_QUARANTINE -j DROP")
    assert rules[-1] == "-I OUTPUT 1 -j VEGA_QUARANTINE"


@pytest.mark.parametrize("connection", [None, "999.0.0.1 50000 192.0.2.11 22", "192.0.2.10 50954 192.0.2.11 0"])
async def test_quarantine_leaves_rules_unchanged_without_valid_management_connection(quarantine_guest, connection):
    executor, guest_env, log = quarantine_guest
    if connection is not None:
        guest_env["SSH_CONNECTION"] = connection
    with pytest.raises(RuntimeError, match="quarantine unchanged"):
        await executor._apply_vm_quarantine("vm-a")
    assert log.read_text() == ""

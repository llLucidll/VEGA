"""Synthetic organizational context and policy catalog for the demo."""

from .schemas import CitedPolicy

ORG_CONTEXT = """\
- Nightly backups run from every managed VM at 02:00 UTC via the systemd service account
  `svc_backup` to the internal vault backup.corp.internal (10.24.8.15). Uploads of 2-6 GB are normal.
- Approved update domains: updates.corp.internal, packages.ubuntu.com. Anything else is unapproved.
- Local admin accounts are only created by IT through the provisioning system, never interactively.
- Production key material lives in /srv/secrets/prod-keys/ and is never archived by engineers.
- Signing requests may only target wallets on the treasury allowlist.
"""

POLICIES: dict[str, CitedPolicy] = {
    p.policy_id: p
    for p in [
        CitedPolicy(
            policy_id="POL-CONTAIN-01",
            title="Automated Host Containment",
            version="v1.0",
            excerpt="Managed hosts may be isolated automatically when compromise is likely and scope is a single host.",
        ),
        CitedPolicy(
            policy_id="POL-CONTAIN-02",
            title="Protected Hosts",
            version="v1.0",
            excerpt="Hosts tagged prod-db or audit-ledger require human approval before any containment.",
        ),
        CitedPolicy(
            policy_id="POL-DATA-04",
            title="Restricted Key Material Handling",
            version="v2.3",
            excerpt="Production key directories may not be archived to local temporary paths or interactive shells.",
        ),
        CitedPolicy(
            policy_id="POL-EGRESS-09",
            title="Unapproved External Transfer Threshold",
            version="v1.8",
            excerpt="Outbound transfers > 25 MB to unverified external ASNs following secret access trigger mandatory SEV1 containment review.",
        ),
        CitedPolicy(
            policy_id="POL-BACKUP-02",
            title="Scheduled Backup Window",
            version="v1.1",
            excerpt="Backups by svc_backup to backup.corp.internal during 02:00-02:30 UTC are authorized and exempt from egress review.",
        ),
    ]
}

PROTECTED_HOSTS: set[str] = set()  # e.g. {"vm-j"} for an audit-ledger host

HISTORICAL_CONTEXT = (
    "No prior SEV1 incidents on these hosts in the last 90 days; the unapproved-domain + key-staging "
    "pattern matches the Q2 red-team exfiltration drill (RT-2026-04)."
)


def policy_text() -> str:
    lines = [f"- {p.policy_id} ({p.title}): {p.excerpt}" for p in POLICIES.values()]
    if PROTECTED_HOSTS:
        lines.append(f"- Protected hosts: {', '.join(sorted(PROTECTED_HOSTS))}")
    return "\n".join(lines)
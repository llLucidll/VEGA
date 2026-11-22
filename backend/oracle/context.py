"""Synthetic organizational context, host profiles and policy catalog for the demo.

A council only ever sees the org facts, the policies, and the profile/history of the ONE
machine it is judging (per-VM isolation).
"""

from .schemas import CitedPolicy

# Org-wide facts. Members cite these by ID so every innocent explanation is traceable.
ORG_FACTS: dict[str, str] = {
    "ORG-BACKUP-01": (
        "Nightly backups run from every managed VM at 02:00 UTC via the systemd service account "
        "`svc_backup` (unit vega-backup.service) to the internal vault backup.corp.internal "
        "(10.24.8.15). Uploads of 2-6 GB are normal."
    ),
    "ORG-UPDATE-01": "Approved update domains: updates.corp.internal, packages.ubuntu.com. Anything else is unapproved.",
    "ORG-ADMIN-01": "Local admin accounts are only created by IT through the provisioning system, never interactively.",
    "ORG-KEYS-01": "Production key material lives in /srv/secrets/prod-keys/ and is never archived by engineers.",
    "ORG-TREASURY-01": "Signing requests may only target wallets on the treasury allowlist.",
    "ORG-PENTEST-01": "Penetration tests are announced in advance with a ticket ID; none is scheduled this week.",
}

ORG_CONTEXT = "\n".join(f"- {fid}: {text}" for fid, text in ORG_FACTS.items())

# Per-host profile and history. Only the judged host's entry is ever shown to its council.
HOST_PROFILES: dict[str, dict[str, str]] = {
    "vm-a": {
        "role": "Application server (payments API)",
        "owner": "eng-payments",
        "normal": "Serves internal API traffic; outbound traffic limited to approved update domains and the 02:00 backup.",
    },
    "vm-b": {
        "role": "Build and artifact server",
        "owner": "eng-platform",
        "normal": "Large nightly backup (3.9-4.6 GB) to backup.corp.internal at 02:00 via svc_backup.",
    },
    "vm-c": {
        "role": "Engineering workstation",
        "owner": "eng-core",
        "normal": "Developer tooling, git and package updates; no credential or offensive-security tooling.",
    },
}

HOST_HISTORY: dict[str, list[str]] = {
    "vm-a": [
        "Nightly backups of 1.8-2.4 GB at 02:00 on each of the last 30 nights, all cleared.",
        "No prior incidents in the last 90 days.",
    ],
    "vm-b": [
        "Nightly backups of 3.9-4.6 GB at 02:00 by svc_backup to backup.corp.internal on each of the last 30 nights, all cleared.",
        "No prior incidents in the last 90 days.",
    ],
    "vm-c": [
        "Approved package update from packages.ubuntu.com last week.",
        "No prior incidents in the last 90 days.",
    ],
}

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


def host_text(source_id: str) -> str:
    """Profile and history for ONE host. Never includes other hosts (per-VM isolation)."""
    profile = HOST_PROFILES.get(source_id)
    history = HOST_HISTORY.get(source_id, [])
    lines = (
        [f"- Role: {profile['role']}", f"- Owner: {profile['owner']}", f"- Normal behavior: {profile['normal']}"]
        if profile
        else ["- No profile on record for this host."]
    )
    lines.append("- History:" if history else "- History: none on record.")
    lines += [f"  - {h}" for h in history]
    return "\n".join(lines)
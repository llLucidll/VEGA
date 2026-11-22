"""Track C: Warden policy-gated containment with TypeSafe AI Jev System One routing."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol

from oracle.context import PROTECTED_HOSTS

from ..config import settings
from ..models import (
    CouncilSignal,
    OracleAssessment,
    PolicyCheck,
    ScoutFinding,
    StoredEvent,
    WardenActionType,
    WardenAuditEntry,
    WardenDecision,
)
from .enforcer import ContainmentExecutor, DryRunContainmentExecutor

LOG = logging.getLogger("vega.warden")


def _now_ts() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3] + "Z"


def _audit(actor: str, message: str, status: str = "info") -> WardenAuditEntry:
    return WardenAuditEntry(
        id=f"aud-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{abs(hash(message)) % 10000}",
        timestamp=_now_ts(),
        actor=actor,  # type: ignore[arg-type]
        message=message,
        status=status,  # type: ignore[arg-type]
    )


@dataclass
class JevEvaluation:
    available: bool
    action_choice: WardenActionType
    confidence: float
    probabilities: dict[str, float]
    credential_compromise: float
    host_compromise: float
    safe_to_automate: float
    model: str
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "action_choice": self.action_choice,
            "confidence": round(self.confidence, 4),
            "probabilities": {k: round(v, 4) for k, v in self.probabilities.items()},
            "credential_compromise": round(self.credential_compromise, 4),
            "host_compromise": round(self.host_compromise, 4),
            "safe_to_automate": round(self.safe_to_automate, 4),
            "model": self.model,
            "error": self.error,
        }


class JevEvaluator(Protocol):
    async def evaluate(self, state: dict[str, Any]) -> JevEvaluation: ...


class TypeSafeJevEvaluator:
    """Calls TypeSafe AI's System One model (Jev) for calibrated containment routing."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "jev-latest",
        timeout_seconds: float = 10.0,
    ) -> None:
        self.api_key = api_key.strip()
        self.model = model
        self.timeout_seconds = timeout_seconds

    async def evaluate(self, state: dict[str, Any]) -> JevEvaluation:
        if not self.api_key:
            return JevEvaluation(
                available=False,
                action_choice="escalate_human",
                confidence=0.0,
                probabilities={},
                credential_compromise=0.0,
                host_compromise=0.0,
                safe_to_automate=0.0,
                model=self.model,
                error="TYPESAFE_API_KEY not configured",
            )

        try:
            from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul

            async with AsyncTypeSafeClient(
                api_key=self.api_key,
                model=self.model,
                timeout=self.timeout_seconds,
            ) as client:
                response = await client.system_one(
                    state=state,
                    questions={
                        "containment_action": Choice(
                            instructions=(
                                "Select the single mutually exclusive containment action for the flagged host(s) "
                                "based on the Oracle assessment, scout findings, and telemetry events."
                            ),
                            criteria={
                                "quarantine_host": (
                                    "Isolate ONLY host network egress when host staging or exfiltration occurred "
                                    "WITHOUT any Vault access, Auth0 token abuse, or secret/key file reads."
                                ),
                                "revoke_credentials": (
                                    "Revoke ONLY Auth0 and Vault credentials when tokens, secrets, or Vault access "
                                    "were abused WITHOUT host archive staging or outbound network exfiltration."
                                ),
                                "quarantine_and_revoke": (
                                    "Isolate host network egress AND revoke Auth0/Vault credentials when BOTH "
                                    "secret/Vault/credential access AND host staging or outbound exfiltration occurred "
                                    "(or when Oracle recommends isolating and revoking sessions)."
                                ),
                                "escalate_human": (
                                    "Escalate to a human operator when evidence is ambiguous, incomplete, "
                                    "involves a protected host, or Oracle did not clearly recommend containment."
                                ),
                            },
                        ),
                        "credential_compromise": Noul(
                            instructions=(
                                "Were credentials, Auth0 tokens, Vault secrets, or production keys "
                                "accessed, abused, or staged for exfiltration?"
                            )
                        ),
                        "host_compromise": Noul(
                            instructions=(
                                "Is the host executing unauthorized archiving, suspicious processes, "
                                "or unapproved outbound network exfiltration?"
                            )
                        ),
                        "safe_to_automate": Noul(
                            instructions=(
                                "Does the correlated evidence clearly justify automated "
                                "containment under Oracle Steward policy?"
                            )
                        ),
                    },
                )

            action = response.choices["containment_action"]
            cred = response.nouls["credential_compromise"].noul
            host = response.nouls["host_compromise"].noul
            safe = response.nouls["safe_to_automate"].noul
            choice = action.choice
            if choice not in (
                "quarantine_host",
                "revoke_credentials",
                "quarantine_and_revoke",
                "escalate_human",
            ):
                choice = "escalate_human"
            return JevEvaluation(
                available=True,
                action_choice=choice,  # type: ignore[arg-type]
                confidence=float(action.confidence),
                probabilities={str(k): float(v) for k, v in action.probabilities.items()},
                credential_compromise=float(cred),
                host_compromise=float(host),
                safe_to_automate=float(safe),
                model=response.model,
            )
        except Exception as exc:  # noqa: BLE001 - fail closed to human authorization
            LOG.warning("Jev evaluation failed; failing closed to human gate: %s", exc)
            return JevEvaluation(
                available=False,
                action_choice="escalate_human",
                confidence=0.0,
                probabilities={},
                credential_compromise=0.0,
                host_compromise=0.0,
                safe_to_automate=0.0,
                model=self.model,
                error=str(exc),
            )


class WardenService(Protocol):
    async def evaluate(
        self,
        assessment: OracleAssessment,
        *,
        signal: CouncilSignal | None = None,
        findings: Iterable[ScoutFinding] = (),
        events: Iterable[StoredEvent] = (),
    ) -> WardenDecision | None:
        """Evaluate policy guardrails and prepare a scoped containment decision."""
        ...


def _action_label(action_type: WardenActionType, hosts: list[str], subjects: dict[str, str]) -> str:
    host_str = ", ".join(hosts)
    subs = [subjects[h] for h in hosts if h in subjects]
    sub_str = ", ".join(subs) if subs else "enrolled Vault subject"
    if action_type == "quarantine_host":
        return f"Quarantine host egress (iptables VEGA_QUARANTINE) on {host_str}"
    if action_type == "revoke_credentials":
        return f"Revoke Auth0 & Vault credentials ({sub_str}) for {host_str}"
    if action_type == "quarantine_and_revoke":
        return f"Quarantine host egress on {host_str} + revoke Auth0/Vault credentials ({sub_str})"
    return f"Manual operator review required for {host_str}"


class JevWardenService:
    """Warden policy gate combining hard deterministic guardrails with Jev System One."""

    def __init__(
        self,
        *,
        jev: JevEvaluator | None = None,
        executor: ContainmentExecutor | None = None,
        vm_subjects: dict[str, str] | None = None,
        confidence_threshold: float | None = None,
        probability_threshold: float | None = None,
        safe_automate_threshold: float | None = None,
    ) -> None:
        self.jev: JevEvaluator = jev or TypeSafeJevEvaluator(
            api_key=settings.typesafe_api_key,
            model=settings.jev_model,
            timeout_seconds=settings.jev_timeout_seconds,
        )
        self.executor: ContainmentExecutor = executor or DryRunContainmentExecutor(vm_subjects)
        self.vm_subjects = dict(vm_subjects if vm_subjects is not None else settings.warden_vm_subjects)
        self.confidence_threshold = (
            settings.jev_confidence_threshold if confidence_threshold is None else confidence_threshold
        )
        self.probability_threshold = (
            settings.jev_probability_threshold if probability_threshold is None else probability_threshold
        )
        self.safe_automate_threshold = (
            settings.jev_safe_automate_threshold
            if safe_automate_threshold is None
            else safe_automate_threshold
        )

    def _build_jev_state(
        self,
        assessment: OracleAssessment,
        signal: CouncilSignal | None,
        findings: list[ScoutFinding],
        events: list[StoredEvent],
        target_hosts: list[str],
    ) -> dict[str, Any]:
        target_set = set(target_hosts)
        relevant_findings = [
            {
                "source_id": f.source_id,
                "channel": f.channel,
                "signal": f.signal,
                "rationale": f.rationale,
                "confidence": f.confidence,
            }
            for f in findings
            if f.source_id in target_set
        ][:12]
        relevant_events = [
            {
                "source_id": e.source_id,
                "channel": e.channel,
                "payload": e.payload,
                "summary": e.summary,
            }
            for e in events
            if e.source_id in target_set
            and not ("top_processes" in e.payload and "cmd" not in e.payload)
        ][-20:]
        return {
            "target_hosts": target_hosts,
            "enrolled_auth0_hosts": [h for h in target_hosts if h in self.vm_subjects],
            "protected_hosts": sorted(PROTECTED_HOSTS),
            "signal": (
                {
                    "severity": signal.severity,
                    "summary": signal.summary,
                    "rationale": signal.rationale,
                    "escalation_rule": signal.escalation_rule,
                }
                if signal
                else None
            ),
            "oracle_assessment": {
                "assessment": assessment.assessment,
                "recommended_action": assessment.recommended_action,
                "recommended_scope": assessment.recommended_scope,
                "uncertainty": assessment.uncertainty,
                "verdicts": [
                    {
                        "source_id": v.source_id,
                        "verdict": v.verdict,
                        "prosecutor_score": v.prosecutor.score if v.prosecutor else None,
                        "defender_score": v.defender.score if v.defender else None,
                        "steward_allowed": v.steward.allowed if v.steward else None,
                        "failures": v.failures,
                    }
                    for v in assessment.verdicts
                ],
            },
            "findings": relevant_findings,
            "events": relevant_events,
        }

    async def evaluate(
        self,
        assessment: OracleAssessment,
        *,
        signal: CouncilSignal | None = None,
        findings: Iterable[ScoutFinding] = (),
        events: Iterable[StoredEvent] = (),
    ) -> WardenDecision | None:
        findings_list = list(findings)
        events_list = list(events)

        if assessment.verdicts:
            contain_hosts = [v.source_id for v in assessment.verdicts if v.verdict == "CONTAIN"]
            escalate_hosts = [v.source_id for v in assessment.verdicts if v.verdict == "ESCALATE"]
        else:
            contain_hosts = list(signal.source_ids) if signal else []
            escalate_hosts = []

        target_hosts = list(dict.fromkeys(contain_hosts + escalate_hosts))
        if not target_hosts:
            return None

        oracle_clear = len(contain_hosts) > 0 and len(escalate_hosts) == 0
        protected_hits = [h for h in target_hosts if h in PROTECTED_HOSTS]
        protected_ok = len(protected_hits) == 0
        scope_ok = len(target_hosts) > 0 and all(h != "vega-core" for h in target_hosts)

        jev_state = self._build_jev_state(
            assessment, signal, findings_list, events_list, target_hosts
        )
        jev = await self.jev.evaluate(jev_state)

        top_prob = jev.probabilities.get(jev.action_choice, 0.0)
        if jev.action_choice == "quarantine_host":
            noul_ok = jev.host_compromise >= 0.70
        elif jev.action_choice == "revoke_credentials":
            noul_ok = jev.credential_compromise >= 0.70
        elif jev.action_choice == "quarantine_and_revoke":
            noul_ok = jev.host_compromise >= 0.70 and jev.credential_compromise >= 0.70
        else:
            noul_ok = False

        jev_classified = jev.available and jev.action_choice != "escalate_human"
        escalate_prob = jev.probabilities.get("escalate_human", 0.0)
        jev_confident = (
            jev_classified
            and escalate_prob <= 0.10
            and jev.confidence >= self.confidence_threshold
            and top_prob >= self.probability_threshold
            and jev.safe_to_automate >= self.safe_automate_threshold
            and noul_ok
        )

        auto_execute = oracle_clear and protected_ok and scope_ok and jev_confident

        if jev_classified:
            chosen_action: WardenActionType = jev.action_choice
        elif any(h in self.vm_subjects for h in target_hosts):
            chosen_action = "quarantine_and_revoke"
        else:
            chosen_action = "quarantine_host"

        now = datetime.now(timezone.utc)
        decision_id = f"wdn-{int(now.timestamp() * 1000)}"

        checks = [
            PolicyCheck(
                id="oracle-verdict",
                label="Oracle Council Verdict",
                passed=oracle_clear,
                detail=(
                    f"CONTAIN on {', '.join(contain_hosts)}"
                    if oracle_clear
                    else f"Oracle escalated {', '.join(escalate_hosts) or 'case'} for human review"
                ),
            ),
            PolicyCheck(
                id="protected-host",
                label="Protected Host Guardrail",
                passed=protected_ok,
                detail=(
                    "No protected hosts in containment scope"
                    if protected_ok
                    else f"Protected host(s) {', '.join(protected_hits)} require human approval"
                ),
            ),
            PolicyCheck(
                id="target-scope",
                label="Scoped Endpoint Target",
                passed=scope_ok,
                detail=f"Bounded target host(s): {', '.join(target_hosts)}",
            ),
            PolicyCheck(
                id="jev-classification",
                label="Jev System One Classification",
                passed=jev_classified,
                detail=(
                    f"Jev selected {jev.action_choice} (p={top_prob:.2f}, conf={jev.confidence:.2f})"
                    if jev.available
                    else f"Jev unavailable ({jev.error or 'error'}); failing closed to human gate"
                ),
            ),
            PolicyCheck(
                id="jev-confidence",
                label="Jev Calibrated Automation Gate",
                passed=jev_confident,
                detail=(
                    f"conf={jev.confidence:.2f} (>={self.confidence_threshold:.2f}), "
                    f"safe={jev.safe_to_automate:.2f} (>={self.safe_automate_threshold:.2f}), "
                    f"cred={jev.credential_compromise:.2f}, host={jev.host_compromise:.2f}"
                    if jev.available
                    else "Confidence gate skipped; human authorization required"
                ),
            ),
        ]

        audit_log = [
            _audit(
                "POLICY_ENGINE",
                (
                    f"Jev ({jev.model}) evaluated {', '.join(target_hosts)}: "
                    f"choice={jev.action_choice}, conf={jev.confidence:.2f}, "
                    f"p={top_prob:.2f}, safe={jev.safe_to_automate:.2f}."
                    if jev.available
                    else f"Jev unavailable ({jev.error}); failing closed to human authorization."
                ),
                "ok" if auto_execute else "warn",
            )
        ]

        if auto_execute:
            approval_ref = f"AUTO-JEV-{decision_id[-4:]}"
            audit_log.append(
                _audit(
                    "WARDEN",
                    f"Deterministic Jev gate passed ({approval_ref}); executing {chosen_action} without human delay.",
                    "ok",
                )
            )
            return WardenDecision(
                decision_id=decision_id,
                incident_id=assessment.incident_id,
                proposed_action=_action_label(chosen_action, target_hosts, self.vm_subjects),
                trusted_target_ref=", ".join(target_hosts),
                scope=f"host:{','.join(target_hosts)}",
                policy_id="POL-JEV-AUTO-01",
                policy_checks=checks,
                requires_human_approval=False,
                approval_status="approved",
                approval_ref=approval_ref,
                expires_at=now + timedelta(minutes=15),
                dry_run=self.executor.dry_run,
                execution_status="executing",
                action_type=chosen_action,
                target_hosts=target_hosts,
                jev_decision=jev.to_dict(),
                audit_log=audit_log,
            )

        audit_log.append(
            _audit(
                "WARDEN",
                f"Human authorization required for {', '.join(target_hosts)} ({chosen_action}).",
                "critical",
            )
        )
        return WardenDecision(
            decision_id=decision_id,
            incident_id=assessment.incident_id,
            proposed_action=_action_label(chosen_action, target_hosts, self.vm_subjects),
            trusted_target_ref=", ".join(target_hosts),
            scope=f"host:{','.join(target_hosts)}",
            policy_id="POL-WARDEN-HUMAN-01",
            policy_checks=checks,
            requires_human_approval=True,
            approval_status="pending",
            approval_ref=None,
            expires_at=now + timedelta(minutes=15),
            dry_run=self.executor.dry_run,
            execution_status="awaiting_authorization",
            action_type=chosen_action,
            target_hosts=target_hosts,
            jev_decision=jev.to_dict(),
            audit_log=audit_log,
        )

    async def enforce_decision(self, decision: WardenDecision, runtime: Any) -> WardenDecision:
        action_type: WardenActionType = decision.action_type or "quarantine_and_revoke"
        if action_type == "escalate_human":
            action_type = (
                "quarantine_and_revoke"
                if any(h in self.vm_subjects for h in decision.target_hosts)
                else "quarantine_host"
            )
        hosts = list(decision.target_hosts)
        if not hosts and runtime.council_signal:
            hosts = [h for h in runtime.council_signal.source_ids if h != "vega-core"]

        result = await self.executor.execute(action_type, hosts)
        decision.audit_log.extend(result.entries)

        if result.succeeded:
            decision.execution_status = "contained_dry_run" if decision.dry_run else "contained"
            runtime.threat_mode = "CONTAINED"
            isolated_set = set(result.isolated_hosts) | set(hosts)
            for node in runtime.nodes:
                if node.source_id != "vega-core" and node.source_id in isolated_set:
                    node.status = "isolated"
        else:
            decision.requires_human_approval = True
            decision.approval_status = "pending"
            decision.execution_status = "awaiting_authorization"
            runtime.threat_mode = "SEV1_ESCALATION"
            decision.audit_log.append(
                _audit(
                    "WARDEN",
                    "Automated containment failed; escalated back to human operator.",
                    "critical",
                )
            )

        runtime.warden_decision = decision
        await runtime.publish("warden_decision", decision)
        await runtime.publish("snapshot", runtime.snapshot())
        return decision

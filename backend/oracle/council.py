"""The Oracle Council.

For every VM in the signal, three members (Prosecutor, Defender, Steward) judge ONLY that
VM's findings. A deterministic Arbiter turns their opinions into a verdict.

Modes (ORACLE_COUNCIL_MODE):
  combined (default): one model call per VM returns all three opinions -> 3 calls for 3 VMs
  separate:           one model call per member                        -> 9 calls for 3 VMs
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable, TypeVar

from pydantic import BaseModel

from . import prompts
from .context import HISTORICAL_CONTEXT, POLICIES, PROTECTED_HOSTS
from .schemas import (
    CompetingExplanation,
    CouncilOpinions,
    DefenderOpinion,
    OracleAssessment,
    OracleRequest,
    ProsecutorOpinion,
    ScoutFinding,
    StewardOpinion,
    StoredEvent,
    VmVerdict,
)

T = TypeVar("T", bound=BaseModel)

ARBITER_VERSION = "arbiter-v1"
MODEL = os.getenv("ORACLE_MODEL", "gemini-3.5-flash-lite")
MEMBER_TIMEOUT_S = float(os.getenv("ORACLE_MEMBER_TIMEOUT", "30"))
THINKING_LEVEL = os.getenv("ORACLE_THINKING_LEVEL")  # e.g. "low"; unset = model default
MAX_CONCURRENCY = int(os.getenv("ORACLE_MAX_CONCURRENCY", "3"))  # max simultaneous model calls (free-tier friendly)
COUNCIL_MODE = os.getenv("ORACLE_COUNCIL_MODE", "combined")

# Arbiter thresholds
CONTAIN_PROSECUTOR = 0.70
CONTAIN_DEFENDER_MAX = 0.40
CLEAR_DEFENDER = 0.70
CLEAR_PROSECUTOR_MAX = 0.50

MEMBERS: dict[str, tuple[str, type[BaseModel]]] = {
    "prosecutor": (prompts.PROSECUTOR, ProsecutorOpinion),
    "defender": (prompts.DEFENDER, DefenderOpinion),
    "steward": (prompts.STEWARD, StewardOpinion),
}

# member caller signature: (member_name, source_id, system_prompt, user_message, schema) -> opinion
MemberCaller = Callable[[str, str, str, str, type[T]], Awaitable[T]]


# ---------- Member callers ----------

def gemini_caller() -> MemberCaller:
    from google import genai
    from google.genai import types

    client = genai.Client()  # reads GEMINI_API_KEY / GOOGLE_API_KEY

    async def call(member: str, source_id: str, system: str, user: str, schema: type[T]) -> T:
        resp = await client.aio.models.generate_content(
            model=MODEL,
            contents=user,
            config=types.GenerateContentConfig(
                system_instruction=system,
                response_mime_type="application/json",
                response_schema=schema,
                temperature=0,
                **({"thinking_config": types.ThinkingConfig(thinking_level=THINKING_LEVEL)} if THINKING_LEVEL else {}),
            ),
        )
        if isinstance(resp.parsed, schema):
            return resp.parsed
        if resp.text:  # fall back to manual parse
            return schema.model_validate_json(resp.text)
        raise ValueError(f"{member}: empty or blocked response")

    return call


def mock_caller(path: Path | None = None) -> MemberCaller:
    path = path or Path(__file__).parent / "fixtures" / "mock_opinions.json"
    canned = json.loads(path.read_text())

    async def call(member: str, source_id: str, system: str, user: str, schema: type[T]) -> T:
        await asyncio.sleep(0.05)
        try:
            if member == "council":
                return schema.model_validate(canned[source_id])
            return schema.model_validate(canned[source_id][member])
        except KeyError:
            raise ValueError(f"no mock opinion for {source_id}/{member}") from None

    return call


# ---------- Arbiter ----------

def arbitrate(v: VmVerdict) -> str:
    if v.failures or not (v.prosecutor and v.defender and v.steward):
        return "ESCALATE"
    if not v.steward.allowed or v.source_id in PROTECTED_HOSTS:
        return "ESCALATE"
    p, d = v.prosecutor.score, v.defender.score
    if p >= CONTAIN_PROSECUTOR and d < CONTAIN_DEFENDER_MAX:
        return "CONTAIN"
    if d >= CLEAR_DEFENDER and p < CLEAR_PROSECUTOR_MAX:
        return "NO_ACTION"
    return "ESCALATE"


# ---------- Council ----------

def _clean(member: str, opinion: BaseModel) -> BaseModel:
    if member == "steward":  # drop hallucinated policy IDs
        opinion.policy_ids = [pid for pid in opinion.policy_ids if pid in POLICIES]
    if member in ("prosecutor", "defender"):
        opinion.score = min(1.0, max(0.0, opinion.score))
    return opinion


async def _run_combined(
    caller: MemberCaller, source_id: str, user: str, fail: set[str], limit: asyncio.Semaphore
) -> list[tuple[str, BaseModel | None, str | None]]:
    forced = {m for m in MEMBERS if f"{source_id}:{m}" in fail}
    try:
        async with limit:
            ops = await asyncio.wait_for(
                caller("council", source_id, prompts.COUNCIL, user, CouncilOpinions), MEMBER_TIMEOUT_S
            )
    except asyncio.TimeoutError:
        return [(m, None, f"{m}: timed out") for m in MEMBERS]
    except Exception as exc:  # noqa: BLE001 - fail closed
        err = f"{type(exc).__name__}: {str(exc)[:120]}"
        return [(m, None, f"{m}: {err}") for m in MEMBERS]
    return [
        (m, None, f"{m}: forced failure") if m in forced else (m, _clean(m, getattr(ops, m)), None)
        for m in MEMBERS
    ]


async def _run_member(
    caller: MemberCaller, member: str, source_id: str, user: str, fail: set[str], limit: asyncio.Semaphore
) -> tuple[str, BaseModel | None, str | None]:
    system, schema = MEMBERS[member]
    if f"{source_id}:{member}" in fail:
        return member, None, f"{member}: forced failure"
    try:
        async with limit:  # limits simultaneous model calls (free-tier quota)
            opinion = await asyncio.wait_for(caller(member, source_id, system, user, schema), MEMBER_TIMEOUT_S)
        return member, _clean(member, opinion), None
    except asyncio.TimeoutError:
        return member, None, f"{member}: timed out"
    except Exception as exc:  # noqa: BLE001 - any failure must fail closed, never crash the council
        return member, None, f"{member}: {type(exc).__name__}: {str(exc)[:120]}"


async def run_vm_council(
    caller: MemberCaller,
    source_id: str,
    findings: list[ScoutFinding],
    events: list[StoredEvent],
    fail: set[str],
    limit: asyncio.Semaphore,
) -> VmVerdict:
    if not findings:
        v = VmVerdict(source_id=source_id, verdict="ESCALATE", prosecutor=None, defender=None,
                      steward=None, failures=["no findings for this source"])
        return v
    user = prompts.member_input(source_id, findings, events)
    if COUNCIL_MODE == "separate":
        results = await asyncio.gather(*(_run_member(caller, m, source_id, user, fail, limit) for m in MEMBERS))
    else:
        results = await _run_combined(caller, source_id, user, fail, limit)
    opinions = {m: o for m, o, _ in results}
    v = VmVerdict(
        source_id=source_id,
        verdict="ESCALATE",
        prosecutor=opinions["prosecutor"],
        defender=opinions["defender"],
        steward=opinions["steward"],
        failures=[err for _, _, err in results if err],
    )
    v.verdict = arbitrate(v)
    return v


async def decide(request: OracleRequest, caller: MemberCaller, model_label: str, fail: set[str] | None = None) -> OracleAssessment:
    fail = fail or set()
    limit = asyncio.Semaphore(MAX_CONCURRENCY)  # one limit per council run
    started = time.perf_counter()
    signal = request.signal

    findings_by_vm: dict[str, list[ScoutFinding]] = defaultdict(list)
    for f in request.findings:
        findings_by_vm[f.source_id].append(f)
    events_by_vm: dict[str, list[StoredEvent]] = defaultdict(list)
    for e in request.events:
        events_by_vm[e.source_id].append(e)

    verdicts = await asyncio.gather(
        *(run_vm_council(caller, sid, findings_by_vm[sid], events_by_vm[sid], fail, limit) for sid in signal.source_ids)
    )
    council_ms = int((time.perf_counter() - started) * 1000)
    return build_assessment(request, list(verdicts), model_label, council_ms)


# ---------- Map council output onto OracleAssessment ----------

def _status(defender_score: float) -> str:
    if defender_score >= CLEAR_DEFENDER:
        return "plausible"
    if defender_score >= CONTAIN_DEFENDER_MAX:
        return "unlikely"
    return "ruled_out"


def build_assessment(request: OracleRequest, verdicts: list[VmVerdict], model_label: str, council_ms: int) -> OracleAssessment:
    signal = request.signal
    by = {k: [v.source_id for v in verdicts if v.verdict == k] for k in ("CONTAIN", "NO_ACTION", "ESCALATE")}

    lines = []
    for v in verdicts:
        if v.verdict == "CONTAIN" and v.prosecutor:
            lines.append(f"{v.source_id}: {v.prosecutor.reason}")
        elif v.verdict == "NO_ACTION" and v.defender:
            lines.append(f"{v.source_id}: {v.defender.reason}")
        else:
            lines.append(f"{v.source_id}: escalated ({'; '.join(v.failures) or 'council did not reach a clear verdict'}).")
    head = (
        f"Council contains {', '.join(by['CONTAIN']) or 'no hosts'}"
        + (f"; takes no action on {', '.join(by['NO_ACTION'])}" if by["NO_ACTION"] else "")
        + (f"; escalates {', '.join(by['ESCALATE'])} for human review" if by["ESCALATE"] else "")
        + "."
    )

    explanations = [
        CompetingExplanation(
            hypothesis=f"{v.source_id}: {v.defender.hypothesis}",
            status=_status(v.defender.score),
            reason=v.defender.reason,
        )
        for v in verdicts
        if v.defender
    ]

    policy_ids: list[str] = []
    for v in verdicts:
        for pid in (v.steward.policy_ids if v.steward else []):
            if pid not in policy_ids:
                policy_ids.append(pid)

    if by["CONTAIN"]:
        action = f"Isolate {', '.join(by['CONTAIN'])} and revoke active sessions"
    elif by["ESCALATE"]:
        action = "Hold for human review; no automated containment"
    else:
        action = "No containment required"

    scope_parts = [f"{', '.join(by['CONTAIN'])} only" if by["CONTAIN"] else "No hosts"]
    if by["NO_ACTION"]:
        scope_parts.append(f"{', '.join(by['NO_ACTION'])} untouched")
    if by["ESCALATE"]:
        scope_parts.append(f"{', '.join(by['ESCALATE'])} awaiting human review")

    uncertainty = (
        "Low: every member returned a valid opinion and each host reached a clear verdict."
        if not by["ESCALATE"]
        else f"Unresolved for {', '.join(by['ESCALATE'])}; failed closed to human review."
    )

    return OracleAssessment(
        incident_id=f"INC-{signal.signal_id}",
        signal_id=signal.signal_id,
        assessment=head + " " + " ".join(lines),
        competing_explanations=explanations,
        cited_policies=[POLICIES[pid] for pid in policy_ids],
        historical_context=HISTORICAL_CONTEXT,
        uncertainty=uncertainty,
        recommended_action=action,
        recommended_scope="; ".join(scope_parts),
        model_version=f"oracle-council/{model_label}/{ARBITER_VERSION}",
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        verdicts=verdicts,
        council_ms=council_ms,
    )
"""Oracle reasoning: citations, arbiter rules and per-VM context isolation."""

import copy
import json
from pathlib import Path

from oracle import council, prompts
from oracle.context import HOST_HISTORY, HOST_PROFILES
from oracle.schemas import OracleRequest

FIXTURES = Path(__file__).resolve().parents[1] / "oracle" / "fixtures"
REQUEST = OracleRequest.model_validate_json((FIXTURES / "three_vm_request.json").read_text())
MOCK = json.loads((FIXTURES / "mock_opinions.json").read_text())


def _only(source_id: str) -> OracleRequest:
    """The demo request narrowed to one VM."""
    return OracleRequest(
        signal=REQUEST.signal.model_copy(update={"source_ids": [source_id]}),
        findings=[f for f in REQUEST.findings if f.source_id == source_id],
        events=[e for e in REQUEST.events if e.source_id == source_id],
    )


def _caller(opinions_by_vm: dict):
    """Member caller returning the given opinions (combined and separate modes)."""

    async def call(member, source_id, system, user, schema):
        ops = opinions_by_vm[source_id]
        return schema.model_validate(ops if member == "council" else ops[member])

    return call


async def _verdict(source_id: str, opinions: dict):
    a = await council.decide(_only(source_id), _caller({source_id: opinions}), "test")
    return a.verdicts[0]


# ---------- demo outcome ----------

async def test_demo_verdicts_and_rules():
    a = await council.decide(REQUEST, council.mock_caller(), "mock")
    got = {v.source_id: (v.verdict, v.rule) for v in a.verdicts}
    assert got == {
        "vm-a": ("CONTAIN", "CONTAIN_STRONG_EVIDENCE"),
        "vm-b": ("NO_ACTION", "CLEARED_INNOCENT_EXPLANATION"),
        "vm-c": ("CONTAIN", "CONTAIN_STRONG_EVIDENCE"),
    }
    for v in a.verdicts:
        assert v.rule_text, f"{v.source_id} has no explanation"
        assert v.citation_errors == [], v.citation_errors


# ---------- citations ----------

async def test_invented_citations_are_removed_and_reported():
    ops = copy.deepcopy(MOCK["vm-a"])
    ops["prosecutor"]["cited_finding_ids"] += ["fnd-made-up", "fnd-b1"]  # fnd-b1 belongs to vm-b
    ops["defender"]["cited_fact_ids"] += ["ORG-NOPE-99"]
    ops["steward"]["policy_ids"] += ["POL-FAKE-00"]

    v = await _verdict("vm-a", ops)

    assert v.prosecutor.cited_finding_ids == ["fnd-a1", "fnd-a2", "fnd-a3"]
    assert "ORG-NOPE-99" not in v.defender.cited_fact_ids
    assert "POL-FAKE-00" not in v.steward.policy_ids
    assert len(v.citation_errors) == 4
    assert v.verdict == "CONTAIN"  # real evidence still stands


async def test_accusation_without_valid_evidence_escalates():
    ops = copy.deepcopy(MOCK["vm-a"])
    ops["prosecutor"]["cited_finding_ids"] = ["fnd-made-up"]
    ops["prosecutor"]["cited_event_ids"] = ["evt-c2"]  # another VM's event

    v = await _verdict("vm-a", ops)

    assert (v.verdict, v.rule) == ("ESCALATE", "UNSUPPORTED_ACCUSATION")


async def test_low_prosecutor_without_citations_is_fine():
    ops = copy.deepcopy(MOCK["vm-b"])
    ops["prosecutor"]["cited_finding_ids"] = []
    ops["prosecutor"]["cited_event_ids"] = []

    v = await _verdict("vm-b", ops)

    assert (v.verdict, v.rule) == ("NO_ACTION", "CLEARED_INNOCENT_EXPLANATION")


async def test_ungrounded_defender_is_flagged_but_score_unchanged():
    ops = copy.deepcopy(MOCK["vm-b"])
    ops["defender"]["cited_fact_ids"] = []

    v = await _verdict("vm-b", ops)

    assert v.defender.score == 0.93
    assert v.verdict == "NO_ACTION"
    assert any("not grounded" in e for e in v.citation_errors)


async def test_member_failure_escalates_with_rule():
    async def broken(*_args, **_kwargs):
        raise RuntimeError("model unavailable")

    a = await council.decide(_only("vm-a"), broken, "test")

    assert (a.verdicts[0].verdict, a.verdicts[0].rule) == ("ESCALATE", "MEMBER_FAILED")


async def test_steward_denial_escalates_with_rule():
    ops = copy.deepcopy(MOCK["vm-a"])
    ops["steward"]["allowed"] = False

    v = await _verdict("vm-a", ops)

    assert (v.verdict, v.rule) == ("ESCALATE", "STEWARD_DENIED")


# ---------- per-VM isolation ----------

def test_member_input_contains_only_its_own_host_context():
    req = _only("vm-a")
    text = prompts.member_input("vm-a", req.findings, req.events)

    assert HOST_PROFILES["vm-a"]["role"] in text
    for other in ("vm-b", "vm-c"):
        assert HOST_PROFILES[other]["role"] not in text
        assert HOST_PROFILES[other]["normal"] not in text
        for line in HOST_HISTORY[other]:
            if line not in HOST_HISTORY["vm-a"]:
                assert line not in text


def test_unknown_host_gets_no_profile_rather_than_another_hosts():
    text = prompts.member_input("vm-zzz", [], [])
    assert "No profile on record" in text
    assert all(p["role"] not in text for p in HOST_PROFILES.values())


def test_every_member_prompt_carries_the_charter():
    for system in (prompts.PROSECUTOR, prompts.DEFENDER, prompts.STEWARD, prompts.COUNCIL):
        assert prompts.CHARTER in system

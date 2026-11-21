"""Oracle Council CLI.

  python -m oracle.main --file oracle/fixtures/three_vm_request.json --mock
  python -m oracle.main --file oracle/fixtures/three_vm_request.json            
  python -m oracle.main --redis [--mock]                                        # consume Redis stream forever
  python -m oracle.main --publish oracle/fixtures/three_vm_request.json         # act as Sentinel (demo/test)

Run from the backend/ directory.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from . import bus, council  # noqa: E402  (after load_dotenv so env vars apply)
from .schemas import OracleAssessment  # noqa: E402

COLORS = {"CONTAIN": "\033[91m", "NO_ACTION": "\033[92m", "ESCALATE": "\033[93m"}
RESET = "\033[0m"


def render(a: OracleAssessment) -> str:
    out = [f"\nORACLE COUNCIL · {a.signal_id} · {a.council_ms / 1000:.1f}s · {a.model_version}\n"]
    out.append(f"{'VM':<8}{'PROSECUTOR':<12}{'DEFENDER':<10}{'STEWARD':<10}VERDICT")
    for v in a.verdicts:
        p = f"{v.prosecutor.score:.2f}" if v.prosecutor else "--"
        d = f"{v.defender.score:.2f}" if v.defender else "--"
        s = ("allowed" if v.steward.allowed else "denied") if v.steward else "--"
        out.append(f"{v.source_id:<8}{p:<12}{d:<10}{s:<10}{COLORS[v.verdict]}{v.verdict}{RESET}")
    out.append("")
    for v in a.verdicts:
        if v.verdict == "NO_ACTION" and v.defender:
            out.append(f"{v.source_id} cleared: {v.defender.reason}")
        elif v.failures:
            out.append(f"{v.source_id} escalated: {'; '.join(v.failures)}")
    out.append("\nWhy:")
    for v in a.verdicts:
        out.append(f"  {v.source_id:<6}{v.rule:<30}{v.rule_text}")
        out.extend(f"  {'':<6}! {err}" for err in v.citation_errors)
    out.append(f"\nAction: {a.recommended_action}\nScope:  {a.recommended_scope}\n")
    return "\n".join(out)


def make_caller(mock: bool):
    return (council.mock_caller(), "mock") if mock else (council.gemini_caller(), council.MODEL)


async def run_file(path: Path, out: Path | None, mock: bool, fail: set[str]) -> int:
    request = bus.read_request_file(path)
    caller, label = make_caller(mock)
    assessment = await council.decide(request, caller, label, fail)
    print(render(assessment))
    out = out or Path("oracle_out") / f"{assessment.signal_id}.json"
    bus.write_assessment_file(assessment, out)
    print(f"Wrote {out}")
    return 0


async def run_redis(mock: bool, from_start: bool) -> int:
    r = bus.redis_client()
    caller, label = make_caller(mock)
    print(f"Oracle listening on {bus.IN_STREAM} -> {bus.OUT_STREAM} ({label})")
    async for entry_id, request in bus.consume_requests(r, from_start):
        if isinstance(request, Exception):
            print(f"[{entry_id}] invalid request skipped: {request}", file=sys.stderr)
            continue
        assessment = await council.decide(request, caller, label)
        out_id = await bus.publish_assessment(r, assessment)
        print(render(assessment))
        print(f"[{entry_id}] -> {bus.OUT_STREAM} {out_id}")
    return 0


async def run_publish(path: Path) -> int:
    r = bus.redis_client()
    entry = await bus.publish_request(r, bus.read_request_file(path))
    print(f"Published {path} to {bus.IN_STREAM} as {entry}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="VEGA Oracle Council")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--file", type=Path, help="OracleRequest JSON file")
    src.add_argument("--redis", action="store_true", help="consume requests from Redis Streams")
    src.add_argument("--publish", type=Path, help="push an OracleRequest JSON to Redis (acts as Sentinel)")
    ap.add_argument("--out", type=Path, help="assessment output path (file mode)")
    ap.add_argument("--mock", action="store_true", help="use canned opinions, no API calls")
    ap.add_argument("--from-start", action="store_true", help="redis mode: also process existing entries")
    ap.add_argument("--fail", action="append", default=[], metavar="VM:MEMBER",
                    help="force a member failure, e.g. vm-c:prosecutor (file mode, for testing)")
    args = ap.parse_args()

    if args.file:
        return asyncio.run(run_file(args.file, args.out, args.mock, set(args.fail)))
    if args.redis:
        return asyncio.run(run_redis(args.mock, args.from_start))
    return asyncio.run(run_publish(args.publish))


if __name__ == "__main__":
    sys.exit(main())
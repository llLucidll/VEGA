"""Structured LLM reasoning abstraction for Sentinel scouts and Correlator."""

from __future__ import annotations

import json
import re
from typing import Any, Protocol, TypeVar

from google import genai
from google.genai import types
from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class StructuredReasoner(Protocol):
    mode_name: str

    async def generate(
        self,
        *,
        system_instruction: str,
        prompt: str,
        response_schema: type[T],
    ) -> T: ...


class GeminiStructuredReasoner:
    """Async Gemini API reasoner using google-genai structured JSON outputs."""

    def __init__(self, *, api_key: str, model: str) -> None:
        self.mode_name = f"gemini:{model}"
        self._model = model
        self._client = genai.Client(api_key=api_key)

    async def generate(
        self,
        *,
        system_instruction: str,
        prompt: str,
        response_schema: type[T],
    ) -> T:
        response = await self._client.aio.models.generate_content(
            model=self._model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                response_schema=response_schema,
                temperature=0.1,
            ),
        )
        parsed = getattr(response, "parsed", None)
        if isinstance(parsed, response_schema):
            return parsed
        if isinstance(parsed, dict):
            return response_schema.model_validate(parsed)
        text = getattr(response, "text", None) or "{}"
        return response_schema.model_validate_json(text)


class HeuristicStructuredReasoner:
    """Offline deterministic fallback when GEMINI_API_KEY is not configured."""

    mode_name = "heuristic-fallback"

    async def generate(
        self,
        *,
        system_instruction: str,
        prompt: str,
        response_schema: type[T],
    ) -> T:
        data = json.loads(prompt)
        schema_name = response_schema.__name__

        if schema_name == "ScoutChunkOutput":
            return response_schema.model_validate(self._analyze_scout_chunk(data))
        if schema_name == "CorrelatorOutput":
            return response_schema.model_validate(self._correlate_findings(data))
        raise ValueError(f"Unsupported schema for HeuristicStructuredReasoner: {schema_name}")

    def _analyze_scout_chunk(self, data: dict[str, Any]) -> dict[str, Any]:
        channel = data.get("channel", "")
        events: list[dict[str, Any]] = data.get("events", [])
        findings: list[dict[str, Any]] = []

        if channel == "file":
            matched_ids = [
                ev["event_id"]
                for ev in events
                if self._matches(
                    ev.get("payload", {}),
                    r"(/srv/secrets|vault-export|hidden_dotfile|\.cache-bundle|read_burst)",
                )
            ]
            if matched_ids:
                findings.append(
                    {
                        "signal": "sensitive_staging_archive",
                        "rationale": (
                            "Detected restricted secret directory access or hidden archive staging "
                            "in temporary storage."
                        ),
                        "evidence_event_ids": matched_ids,
                        "confidence": "high",
                    }
                )

        elif channel == "process":
            matched_ids = [
                ev["event_id"]
                for ev in events
                if self._matches(
                    ev.get("payload", {}),
                    r"(tar\s+-c|/srv/secrets|\.tar\.gz|base64|nc\s+-e)",
                )
            ]
            if matched_ids:
                findings.append(
                    {
                        "signal": "anomalous_archive_command",
                        "rationale": (
                            "Observed interactive shell archiving restricted paths into a hidden "
                            "temporary bundle."
                        ),
                        "evidence_event_ids": matched_ids,
                        "confidence": "high",
                    }
                )

        elif channel == "network":
            matched_ids = [
                ev["event_id"]
                for ev in events
                if self._matches(
                    ev.get("payload", {}),
                    r"(198\.51\.100\.|egress-drop|UNTRUSTED|rejected)",
                )
                or (
                    isinstance(ev.get("payload", {}).get("bytes_out"), (int, float))
                    and ev["payload"]["bytes_out"] >= 25_000_000
                    and not ev.get("payload", {}).get("internal", False)
                )
            ]
            if matched_ids:
                origins = sorted(
                    {
                        str(ev.get("payload", {}).get("src"))
                        for ev in events
                        if ev["event_id"] in matched_ids and ev.get("payload", {}).get("src")
                    }
                )
                origin_note = f" (origin: {', '.join(origins)})" if origins else ""
                findings.append(
                    {
                        "signal": "unapproved_external_egress_and_probe",
                        "rationale": (
                            "Detected large outbound transfer to an untrusted external ASN or "
                            f"rejected lateral SSH probe{origin_note}."
                        ),
                        "evidence_event_ids": matched_ids,
                        "confidence": "high",
                    }
                )

        return {"findings": findings}

    def _correlate_findings(self, data: dict[str, Any]) -> dict[str, Any]:
        findings: list[dict[str, Any]] = data.get("findings", [])
        if not findings:
            return {
                "should_escalate": False,
                "severity": "LOW",
                "summary": "No suspicious findings in window.",
                "rationale": "All channel scouts returned empty findings.",
                "source_ids": [],
                "finding_refs": [],
                "evidence_event_ids": [],
                "escalation_rule": "NONE",
            }

        by_source: dict[str, list[dict[str, Any]]] = {}
        for f in findings:
            by_source.setdefault(f["source_id"], []).append(f)

        correlated_sources = [
            sid
            for sid, items in by_source.items()
            if len({item["channel"] for item in items}) >= 2
        ]

        if not correlated_sources:
            return {
                "should_escalate": False,
                "severity": "LOW",
                "summary": "Findings across unrelated sources did not meet correlation threshold.",
                "rationale": (
                    "No single source exhibited multi-channel corroboration in this window."
                ),
                "source_ids": [],
                "finding_refs": [],
                "evidence_event_ids": [],
                "escalation_rule": "NONE",
            }

        # Include primary correlated source(s) plus any finding explicitly referencing them
        primary_set = set(correlated_sources)
        selected = [
            f
            for f in findings
            if f["source_id"] in primary_set
            or any(sid in json.dumps(f) for sid in primary_set)
        ]
        channels = {f["channel"] for f in selected}
        sources = sorted({f["source_id"] for f in selected})
        finding_refs = [f["finding_id"] for f in selected]
        evidence_ids: list[str] = []
        for f in selected:
            for eid in f.get("evidence_event_ids", []):
                if eid not in evidence_ids:
                    evidence_ids.append(eid)

        return {
            "should_escalate": True,
            "severity": "SEV1",
            "summary": (
                f"Correlated multi-channel threat activity across {', '.join(sorted(channels))} "
                f"on {', '.join(sources)}"
            ),
            "rationale": (
                f"Combined {len(selected)} scout findings across {len(channels)} channels "
                f"({', '.join(sorted(channels))}) citing {len(evidence_ids)} preserved events."
            ),
            "source_ids": sources,
            "finding_refs": finding_refs,
            "evidence_event_ids": evidence_ids,
            "escalation_rule": "RULE-EXFIL-MULTI-CHANNEL-01",
        }

    @staticmethod
    def _matches(payload: dict[str, Any], pattern: str) -> bool:
        serialized = json.dumps(payload, sort_keys=True)
        return bool(re.search(pattern, serialized, re.IGNORECASE))

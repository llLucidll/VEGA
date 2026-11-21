"""Track C: Warden policy-gated dry-run enforcement interface."""

from typing import Protocol

from ..models import OracleAssessment, WardenDecision


class WardenService(Protocol):
    async def evaluate(self, assessment: OracleAssessment) -> WardenDecision:
        """Evaluate policy guardrails and prepare a scoped dry-run containment decision."""
        ...

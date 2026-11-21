"""Track C: Oracle contextual assessment interface."""

from typing import Protocol, Sequence

from ..models import CouncilSignal, OracleAssessment, ScoutFinding


class OracleService(Protocol):
    async def assess(
        self, signal: CouncilSignal, findings: Sequence[ScoutFinding]
    ) -> OracleAssessment:
        """Evaluate a Sentinel-confirmed SEV1 against synthetic policies and history."""
        ...

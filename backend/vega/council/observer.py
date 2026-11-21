"""Track C: Observer conversational Q&A interface."""

from typing import Protocol

from ..models import ObserverQA, StateSnapshot


class ObserverService(Protocol):
    async def answer(self, prompt: str, state: StateSnapshot) -> ObserverQA:
        """Answer operator questions with evidence-backed event_id citations."""
        ...

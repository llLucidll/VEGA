"""FastAPI entry point for VEGA ingest, SSE streaming, swarm orchestration, and council endpoints."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone

from fastapi import Body, FastAPI, HTTPException, Query, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from .config import settings
from .council import (
    ContainmentExecutor,
    DryRunContainmentExecutor,
    JevWardenService,
    LiveContainmentExecutor,
)
from .models import (
    Channel,
    EventIn,
    IngestResponse,
    ObserverAskRequest,
    ObserverQA,
    StateSnapshot,
    WardenAuditEntry,
    WardenDecision,
)
from .state import VegaRuntimeState
from .streams import (
    EventMapper,
    InMemoryStreamStore,
    RedisStreamStore,
    StreamStore,
    StreamStoreUnavailable,
)
from .swarm import (
    ChannelScout,
    GeminiChannelScout,
    GeminiStructuredReasoner,
    GeminiWindowCorrelator,
    HeuristicStructuredReasoner,
    StructuredReasoner,
    SwarmWindowCoordinator,
    WindowRunResult,
    WindowScheduler,
)


def build_stream_store() -> StreamStore:
    if settings.stream_backend == "redis":
        return RedisStreamStore(settings.redis_url)
    return InMemoryStreamStore()


def build_reasoner() -> StructuredReasoner:
    if settings.swarm_mode == "gemini" or (
        settings.swarm_mode == "auto" and settings.gemini_api_key.strip()
    ):
        return GeminiStructuredReasoner(
            api_key=settings.gemini_api_key.strip(),
            model=settings.gemini_model,
        )
    return HeuristicStructuredReasoner()


store: StreamStore = build_stream_store()
mapper = EventMapper(store)
runtime = VegaRuntimeState()
reasoner: StructuredReasoner = build_reasoner()

scouts: dict[Channel, ChannelScout] = {
    "file": GeminiChannelScout(channel="file", reasoner=reasoner),
    "network": GeminiChannelScout(channel="network", reasoner=reasoner),
    "process": GeminiChannelScout(channel="process", reasoner=reasoner),
}
correlator = GeminiWindowCorrelator(reasoner=reasoner)
coordinator = SwarmWindowCoordinator(
    store=store,
    scouts=scouts,
    correlator=correlator,
    runtime=runtime,
    max_concurrency=settings.swarm_max_concurrency,
    stage_delay_seconds=settings.stage_delay_seconds,
)
scheduler = WindowScheduler(
    coordinator=coordinator,
    runtime=runtime,
    window_seconds=settings.window_seconds,
    early_analysis=settings.early_analysis,
)

def build_containment_executor() -> ContainmentExecutor:
    if settings.warden_dry_run:
        return DryRunContainmentExecutor(settings.warden_vm_subjects)
    return LiveContainmentExecutor(
        auth0_domain=settings.auth0_domain,
        auth0_client_id=settings.auth0_warden_client_id,
        auth0_client_secret=settings.auth0_warden_secret,
        vm_subjects=settings.warden_vm_subjects,
        telemetry_host=settings.warden_telemetry_host,
    )


containment_executor: ContainmentExecutor = build_containment_executor()
warden_service = JevWardenService(
    executor=containment_executor,
    vm_subjects=settings.warden_vm_subjects,
)


async def _handle_oracle_assessment(assessment, signal, findings, events) -> None:
    if not settings.warden_enabled:
        return
    if settings.stage_delay_seconds > 0:
        await asyncio.sleep(settings.stage_delay_seconds)
        if runtime.council_signal != signal:
            return
    await runtime.wait_if_paused()
    if runtime.council_signal != signal:
        return
    decision = await warden_service.evaluate(
        assessment,
        signal=signal,
        findings=findings,
        events=events,
    )
    if runtime.council_signal != signal:
        return
    if decision is None:
        cleared_ids = {
            v.source_id for v in assessment.verdicts if v.verdict == "NO_ACTION"
        }
        if not cleared_ids and not assessment.verdicts:
            cleared_ids = set(signal.source_ids)
        if cleared_ids:
            for node in runtime.nodes:
                if node.source_id in cleared_ids and node.status in {"elevated", "compromised"}:
                    node.status = "healthy"
            status_by_id = {n.source_id: n.status for n in runtime.nodes}
            for edge in runtime.edges:
                if edge.from_node in cleared_ids or edge.to_node in cleared_ids:
                    if (
                        status_by_id.get(edge.from_node) not in {"elevated", "compromised"}
                        and status_by_id.get(edge.to_node) not in {"elevated", "compromised"}
                    ):
                        edge.anomalous = False
            if runtime.warden_decision is None and not any(
                n.status in {"elevated", "compromised"}
                for n in runtime.nodes
                if n.source_id != "vega-core"
            ):
                runtime.threat_mode = "WATCH"
            await runtime.publish("snapshot", runtime.snapshot())
        return
    runtime.warden_decision = decision
    if not decision.requires_human_approval:
        await runtime.publish("warden_decision", decision)
        await warden_service.enforce_decision(decision, runtime)
        return
    runtime.threat_mode = "SEV1_ESCALATION"
    await runtime.publish("warden_decision", decision)
    await runtime.publish("snapshot", runtime.snapshot())


# Oracle council: runs on every SEV1 signal when ORACLE_BRIDGE=1 (no effect otherwise).
from oracle.sentinel_bridge import attach as attach_oracle  # noqa: E402

oracle_bridge = attach_oracle(
    coordinator,
    runtime,
    on_assessment=_handle_oracle_assessment,
    stage_delay_s=settings.stage_delay_seconds,
)


async def _cleanup_loop() -> None:
    while True:
        await asyncio.sleep(settings.cleanup_interval_seconds)
        with suppress(StreamStoreUnavailable):
            await store.trim_expired(settings.retention_seconds)
            runtime.oldest_stream_event_at = await store.oldest_event_time()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    cleanup_task = asyncio.create_task(_cleanup_loop())
    scheduler.start()
    try:
        yield
    finally:
        await scheduler.stop()
        cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task
        close_fn = getattr(store, "close", None)
        if callable(close_fn):
            await close_fn()


app = FastAPI(title="VEGA Backend", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, exc: RequestValidationError) -> JSONResponse:
    # Ephemeral Streams spec uses 400 for malformed event envelopes rather than 422.
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/health")
async def health() -> dict[str, object]:
    ok = await store.health()
    if not ok:
        raise HTTPException(status_code=503, detail="Stream store unhealthy")
    return {
        "status": "ok",
        "stream_backend": settings.stream_backend,
        "reasoner_mode": reasoner.mode_name,
        "channels": list(settings.channels),
        "retention_seconds": settings.retention_seconds,
        "window_seconds": settings.window_seconds,
        "early_analysis": settings.early_analysis,
    }


@app.post("/events", response_model=IngestResponse, status_code=status.HTTP_201_CREATED)
async def ingest_event(event: EventIn) -> IngestResponse:
    async with scheduler.lifecycle_lock:
        try:
            stream_id, stored = await mapper.ingest(event)
        except StreamStoreUnavailable as exc:
            raise HTTPException(status_code=503, detail="Stream store unavailable") from exc
        runtime.record_event(stored)
        await runtime.publish("event", stored)
        scheduler.observe(stored)
    return IngestResponse(stream_id=stream_id)


@app.get("/api/state", response_model=StateSnapshot)
async def get_state() -> StateSnapshot:
    with suppress(StreamStoreUnavailable):
        runtime.oldest_stream_event_at = await store.oldest_event_time()
    return runtime.snapshot()


@app.get("/api/stream")
async def stream_events() -> StreamingResponse:
    queue = runtime.subscribe()

    async def event_generator():
        try:
            with suppress(StreamStoreUnavailable):
                runtime.oldest_stream_event_at = await store.oldest_event_time()
            yield f"event: snapshot\ndata: {runtime.snapshot().model_dump_json(by_alias=True)}\n\n"
            while True:
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield frame
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            runtime.unsubscribe(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@app.post("/api/demo/flush-window")
async def flush_window(wait: bool = Query(default=True)) -> dict[str, object]:
    """Close the active window immediately, open the next window, and run the Sentinel swarm."""
    result = await scheduler.flush_current_window(wait=wait)
    if isinstance(result, WindowRunResult):
        return {
            "window_id": result.window.id,
            "status": result.window.status,
            "chunks_analyzed": result.chunks_analyzed,
            "chunks_reused": result.chunks_reused,
            "findings_count": len(result.findings),
            "council_signal": (
                result.signal.model_dump(mode="json") if result.signal is not None else None
            ),
            "next_window_id": runtime.active_window_id,
        }
    return {
        "window_id": result.id,
        "status": "scheduled",
        "next_window_id": runtime.active_window_id,
    }


@app.post("/api/warden/{decision_id}/authorize", response_model=WardenDecision)
async def authorize_warden(decision_id: str) -> WardenDecision:
    decision = runtime.warden_decision
    if decision is None or decision.decision_id != decision_id:
        raise HTTPException(status_code=404, detail="Warden decision not found")

    decision.approval_status = "approved"
    decision.approval_ref = f"APR-LIVE-{decision_id[-4:]}"
    decision.execution_status = "executing"
    entry = WardenAuditEntry(
        id=f"aud-{int(datetime.now(timezone.utc).timestamp() * 1000)}",
        timestamp=datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3] + "Z",
        actor="OPERATOR",
        message=f"Operator authorized containment ({decision.approval_ref}).",
        status="ok",
    )
    runtime.append_warden_audit(entry)
    await runtime.publish("warden_decision", decision)
    return await warden_service.enforce_decision(decision, runtime)


@app.post("/api/warden/{decision_id}/deny", response_model=WardenDecision)
async def deny_warden(decision_id: str) -> WardenDecision:
    decision = runtime.warden_decision
    if decision is None or decision.decision_id != decision_id:
        raise HTTPException(status_code=404, detail="Warden decision not found")

    decision.approval_status = "denied"
    decision.execution_status = "denied"
    entry = WardenAuditEntry(
        id=f"aud-{int(datetime.now(timezone.utc).timestamp() * 1000)}",
        timestamp=datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3] + "Z",
        actor="OPERATOR",
        message="Containment request denied by operator.",
        status="warn",
    )
    runtime.append_warden_audit(entry)
    await runtime.publish("warden_decision", decision)
    return decision


@app.post("/api/observer/ask", response_model=ObserverQA)
async def ask_observer(req: ObserverAskRequest) -> ObserverQA:
    # Track C replaces this baseline summary with Gemini-backed case reasoning.
    snap = runtime.snapshot()
    cited_events = [ev.event_id for ev in snap.events[-5:]]
    cited_findings = [f.finding_id for f in snap.findings]
    return ObserverQA(
        id=f"qa-{int(datetime.now(timezone.utc).timestamp() * 1000)}",
        prompt=req.prompt,
        answer=(
            f"Observed {len(snap.events)} events and {len(snap.findings)} scout findings "
            f"in window {snap.active_window_id} (mode: {snap.threat_mode})."
        ),
        summary_bullets=[
            f"Active window: {snap.active_window_id}",
            f"Preserved evidence records: {len(runtime.preserved_evidence)}",
        ],
        cited_event_ids=cited_events,
        cited_finding_ids=cited_findings,
        confidence="medium",
    )


@app.post("/api/demo/exfil-sink")
async def demo_exfil_sink(request: Request) -> dict[str, object]:
    """Harmless local upload sink for VM exfiltration demos (discards payload)."""
    body = await request.body()
    return {"status": "sink_received", "bytes": len(body)}


class PauseRequest(BaseModel):
    paused: bool | None = None


@app.post("/api/demo/pause")
async def set_demo_pause(req: PauseRequest | None = Body(default=None)) -> dict[str, bool]:
    next_paused = (
        (not runtime.pipeline_paused)
        if (req is None or req.paused is None)
        else req.paused
    )
    runtime.set_pipeline_paused(next_paused)
    await runtime.publish("snapshot", runtime.snapshot())
    return {"pipeline_paused": runtime.pipeline_paused}


@app.post("/api/demo/reset")
async def reset_demo() -> dict[str, str]:
    runtime.set_pipeline_paused(False)
    async with scheduler.lifecycle_lock:
        hosts = sorted(
            {n.source_id for n in runtime.nodes if n.source_id != "vega-core"}
            | set(settings.warden_vm_subjects.keys())
        )
        await containment_executor.release_all(hosts)
        try:
            await store.reset_demo_streams()
        except StreamStoreUnavailable as exc:
            raise HTTPException(status_code=503, detail="Stream store unavailable") from exc
        await scheduler.reset()
        runtime.reset()
        await runtime.publish("snapshot", runtime.snapshot())
    return {"status": "reset"}

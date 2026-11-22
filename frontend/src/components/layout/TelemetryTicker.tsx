import { Activity, Lock, Pause, Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { formatTtl, measureTelemetry, sampleTelemetry } from '../../engine/telemetryMetrics'
import { useVegaStore } from '../../store/useVegaStore'

const count = new Intl.NumberFormat()

export function TelemetryTicker() {
  const dataMode = useVegaStore((s) => s.dataMode)
  const liveStatus = useVegaStore((s) => s.liveStatus)
  const hasWindowData = useVegaStore((s) => s.windows.length > 0)
  const windowId = useVegaStore((s) => s.activeWindowId)
  const ttl = useVegaStore((s) => s.ttlSecondsRemaining)
  const nodes = useVegaStore((s) => s.nodes)
  const events = useVegaStore((s) => s.events)
  const snapshotSaved = useVegaStore((s) => s.councilSignal?.snapshot_preserved)
  const [now, setNow] = useState(() => Date.now())
  const [paused, setPaused] = useState(false)
  const simulated = dataMode === 'SIMULATED'
  const liveReady = liveStatus === 'connected' && hasWindowData
  const available = simulated || liveReady

  useEffect(() => {
    if (!liveReady || simulated) return
    const tick = () => setNow(Date.now())
    const frame = window.requestAnimationFrame(tick)
    const timer = window.setInterval(tick, 1000)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearInterval(timer)
    }
  }, [simulated, liveReady])

  const { samples, latestIngest, captured, flagged } = useMemo(() => sampleTelemetry(events), [events])
  const { eventsPerMinute, online, monitored } = measureTelemetry(
    samples,
    nodes,
    simulated ? latestIngest : now,
    dataMode,
  )
  const sourceLabel = simulated ? 'Replay' : liveReady ? 'Live' : liveStatus === 'disconnected' ? 'Offline' : 'Connecting'
  const sourceTone = sourceLabel === 'Live' ? 'bg-emerald-400' : sourceLabel === 'Offline' ? 'bg-rose-400' : 'bg-amber-300'

  const metrics = (
    <>
      <div className="vega-ticker-item" title="Telemetry source status">
        <dt className="sr-only">Source</dt>
        <dd className="flex items-center gap-2 text-[10px] tracking-wider text-slate-200 uppercase">
          <span aria-hidden="true" className={`size-1.5 rounded-full ${sourceTone}`} />
          {sourceLabel}
        </dd>
      </div>
      <Metric
        label="Ingest rate"
        value={available ? count.format(eventsPerMinute) : '—'}
        unit={available ? 'evt/min' : undefined}
        note={simulated ? '60 seconds of recorded ingest time, ending at the latest replayed event.' : 'Events ingested in the last 60 seconds.'}
      />
      <Metric label="TTL" value={available ? formatTtl(ttl) : '—'} note="Telemetry retention countdown (minutes:seconds)." />
      <Metric label="Active window" value={available ? windowId : '—'} />
      <Metric
        label="Nodes online"
        value={available ? `${online}/${monitored}` : '—'}
        note={simulated ? 'Simulated endpoints with a recent heartbeat, excluding isolated nodes and VEGA-CORE.' : 'Non-isolated endpoints with telemetry in the last 2 minutes. VEGA-CORE is not counted.'}
      />
      <Metric label="Captured" value={available ? count.format(captured) : '—'} note="Events currently loaded into the dashboard." />
      <Metric label="Flagged" value={available ? count.format(flagged) : '—'} note="Captured events marked suspicious." />
      {available && snapshotSaved && (
        <div className="vega-ticker-item">
          <dt className="sr-only">Evidence</dt>
          <dd className="flex items-center gap-1.5 text-emerald-300">
            <Lock aria-hidden="true" className="size-3" />
            Snapshot preserved
          </dd>
        </div>
      )}
    </>
  )

  return (
    <aside className="vega-ticker pointer-events-auto flex" aria-labelledby="telemetry-heading">
      <h2
        id="telemetry-heading"
        className="flex shrink-0 items-center gap-2 border-r border-slate-400/15 px-3 font-display text-[11px] tracking-[0.04em] text-slate-200 lowercase sm:px-6"
      >
        <Activity aria-hidden="true" className="size-3.5 text-sky-300" />
        Telemetry
      </h2>
      <div className="vega-ticker-window min-w-0 flex-1">
        <div className="vega-ticker-track font-mono-tabular text-[11px]" data-paused={paused}>
          <dl className="vega-ticker-cycle">{metrics}</dl>
          <dl className="vega-ticker-cycle" aria-hidden="true">{metrics}</dl>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setPaused((current) => !current)}
        aria-label={paused ? 'Resume telemetry ticker' : 'Pause telemetry ticker'}
        title={paused ? 'Resume telemetry ticker' : 'Pause telemetry ticker'}
        className="vega-ticker-toggle grid w-10 shrink-0 cursor-pointer place-items-center border-l border-slate-400/15 text-slate-300 hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-300"
      >
        {paused ? <Play aria-hidden="true" className="size-3.5" /> : <Pause aria-hidden="true" className="size-3.5" />}
      </button>
    </aside>
  )
}

function Metric({ label, value, unit, note }: { label: string; value: string; unit?: string; note?: string }) {
  return (
    <div className="vega-ticker-item" title={note}>
      <dt className="text-slate-400">
        {label}
        {note && <span className="sr-only"> ({note})</span>}
      </dt>
      <dd className="font-medium text-slate-100">
        {value}
        {unit && (
          <>
            <span aria-hidden="true" className="ml-1 text-[9px] font-normal text-slate-400">{unit}</span>
            <span className="sr-only"> events per minute</span>
          </>
        )}
      </dd>
    </div>
  )
}

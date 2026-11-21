import { Activity, Clock, Command, Lock, Radio, ShieldAlert } from 'lucide-react'
import { vegaSource } from '../../engine/sourceManager'
import { useVegaStore } from '../../store/useVegaStore'

function formatTtl(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(s / 60)
  const rem = s % 60
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`
}

export function TopHud() {
  const threatMode = useVegaStore((s) => s.threatMode)
  const activeWindowId = useVegaStore((s) => s.activeWindowId)
  const ttlSecondsRemaining = useVegaStore((s) => s.ttlSecondsRemaining)
  const councilSignal = useVegaStore((s) => s.councilSignal)
  const dataMode = useVegaStore((s) => s.dataMode)
  const liveStatus = useVegaStore((s) => s.liveStatus)
  const setStage = useVegaStore((s) => s.setStage)
  const setObserverOpen = useVegaStore((s) => s.setObserverOpen)
  const observerOpen = useVegaStore((s) => s.observerOpen)

  const threatBadgeClass =
    threatMode === 'WATCH'
      ? 'border-sky-400/40 bg-sky-500/10 text-sky-300'
      : threatMode === 'INVESTIGATE'
        ? 'border-purple-400/40 bg-purple-500/15 text-purple-300'
        : threatMode === 'CONTAINED'
          ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
          : 'border-red-500/60 bg-red-500/20 text-red-300 animate-pulse'

  const modeBadgeClass =
    dataMode === 'LIVE'
      ? liveStatus === 'connected'
        ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
        : liveStatus === 'connecting'
          ? 'border-amber-400/40 bg-amber-500/15 text-amber-300'
          : 'border-red-400/40 bg-red-500/15 text-red-300'
      : 'border-amber-400/30 bg-amber-500/10 text-amber-300'

  const modeBadgeText =
    dataMode === 'LIVE'
      ? `LIVE • ${liveStatus.toUpperCase()} • DRY-RUN`
      : 'SIMULATED • DRY-RUN'

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center justify-between border-b border-slate-800/80 bg-[#060a14]/90 px-5 backdrop-blur-md">
      {/* Brand + Simulation/Live Guardrail */}
      <div className="flex items-center gap-3.5">
        <button
          type="button"
          onClick={() => setStage('panopticon')}
          className="flex items-center gap-2.5 text-left transition hover:opacity-90"
          title="Return to Panopticon Topology"
        >
          <span
            className="inline-block h-2.5 w-2.5 rounded-full shadow-[0_0_12px_var(--vega-accent)]"
            style={{ backgroundColor: 'var(--vega-accent)' }}
          />
          <span className="text-sm font-bold tracking-[0.24em] text-slate-100">VEGA</span>
        </button>

        <span className="hidden font-mono-tabular text-[10px] tracking-[0.18em] text-slate-500 uppercase md:inline">
          SENTINEL • ORACLE • WARDEN
        </span>

        <span
          className={`hidden items-center gap-1.5 rounded border px-2 py-0.5 font-mono-tabular text-[10px] font-medium tracking-wider lg:inline-flex ${modeBadgeClass}`}
        >
          <Radio className="h-3 w-3" />
          {modeBadgeText}
        </span>
      </div>

      {/* Telemetry Status + Observer Trigger */}
      <div className="flex items-center gap-2.5">
        <div className="hidden items-center gap-2 rounded border border-slate-800 bg-slate-900/70 px-2.5 py-1 font-mono-tabular text-[11px] text-slate-300 sm:flex">
          <Activity className="h-3.5 w-3.5 text-sky-400" />
          <span>{activeWindowId}</span>
          <span className="text-slate-600">|</span>
          <Clock className="h-3.5 w-3.5 text-slate-400" />
          <span>TTL {formatTtl(ttlSecondsRemaining)}</span>
          {councilSignal?.snapshot_preserved && (
            <span className="ml-1 inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
              <Lock className="h-2.5 w-2.5" />
              SNAPSHOT
            </span>
          )}
        </div>

        <div
          className={`flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono-tabular text-[11px] font-semibold tracking-wider ${threatBadgeClass}`}
        >
          <ShieldAlert className="h-3.5 w-3.5" />
          <span>{threatMode}</span>
        </div>

        <button
          type="button"
          onClick={() => {
            if (observerOpen) setObserverOpen(false)
            else vegaSource.jumpToStage('observer')
          }}
          title="Ask VEGA Observer (Cmd/Ctrl+K)"
          className="inline-flex items-center gap-1.5 rounded border border-slate-700/80 bg-slate-900/80 px-2.5 py-1 font-mono-tabular text-[11px] text-slate-300 transition hover:border-sky-400/50 hover:text-white"
        >
          <span>OBSERVER</span>
          <span className="inline-flex items-center gap-0.5 rounded bg-slate-800 px-1 py-0.5 text-[10px] text-slate-400">
            <Command className="h-2.5 w-2.5" />K
          </span>
        </button>
      </div>
    </header>
  )
}

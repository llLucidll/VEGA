import { ArrowRight, Cpu, FileText, Globe, Lock, Radar, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import type { Channel } from '../../contracts/vega'
import { vegaSource } from '../../engine/sourceManager'
import { useVegaStore } from '../../store/useVegaStore'

const CHANNEL_META: Record<Channel, { label: string; color: string; icon: typeof FileText }> = {
  file: { label: 'FILE', color: 'text-sky-300 border-sky-400/30 bg-sky-500/10', icon: FileText },
  network: {
    label: 'NETWORK',
    color: 'text-cyan-300 border-cyan-400/30 bg-cyan-500/10',
    icon: Globe,
  },
  process: {
    label: 'PROCESS',
    color: 'text-indigo-300 border-indigo-400/30 bg-indigo-500/10',
    icon: Cpu,
  },
}

export function GhostProtocolPanel({ headerHeight }: { headerHeight: number }) {
  const stage = useVegaStore((s) => s.stage)
  const dataMode = useVegaStore((s) => s.dataMode)
  const nodes = useVegaStore((s) => s.nodes)
  const events = useVegaStore((s) => s.events)
  const findings = useVegaStore((s) => s.findings)
  const selectedNodeId = useVegaStore(
    (s) =>
      s.selectedNodeId ??
      s.findings.at(-1)?.source_id ??
      s.nodes.find((n) => n.source_id !== 'vega-core')?.source_id ??
      (s.dataMode === 'SIMULATED' ? 'vm-a' : s.nodes[0]?.source_id ?? null),
  )
  const councilSignal = useVegaStore((s) => s.councilSignal)
  const selectedEventId = useVegaStore((s) => s.selectedEventId)
  const selectEvent = useVegaStore((s) => s.selectEvent)
  const setStage = useVegaStore((s) => s.setStage)

  const [channelFilter, setChannelFilter] = useState<'all' | Channel>('all')

  const node = selectedNodeId ? nodes.find((n) => n.source_id === selectedNodeId) : undefined
  const nodeEvents = selectedNodeId
    ? events.filter(
        (e) =>
          (e.source_id === selectedNodeId || e.payload.src === selectedNodeId) &&
          (channelFilter === 'all' || e.channel === channelFilter),
      )
    : []
  const nodeFindings = selectedNodeId
    ? findings.filter((f) => f.source_id === selectedNodeId)
    : []

  return (
    <AnimatePresence>
      {stage === 'ghost_protocol' && (
        <motion.aside
          initial={{ x: 460, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 460, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 32 }}
          style={{ top: `max(8rem, ${headerHeight + 6}px)` }}
          className="vega-panel absolute right-4 bottom-16 z-20 flex w-[440px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl"
        >
          {/* Header */}
          <div className="flex items-start justify-between border-b border-slate-800/90 px-4 py-3">
            <div>
              <div className="flex items-center gap-2 font-mono-tabular text-[10px] tracking-[0.2em] text-sky-400 uppercase">
                <Radar className="h-3.5 w-3.5" />
                <span>02 / GHOST PROTOCOL — SENTINEL</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <h2 className="font-mono-tabular text-base font-bold text-white">
                  {node?.source_id ?? selectedNodeId ?? 'No endpoint'}
                </h2>
                <span className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono-tabular text-[10px] text-slate-300">
                  <Lock className="h-2.5 w-2.5 text-amber-300" />
                  {node?.pseudonym ?? (dataMode === 'SIMULATED' ? 'subj-042' : 'unassigned')} • IDENTITY SEALED
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setStage('panopticon')}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              title="Return to Panopticon"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Channel Filter Tabs */}
          <div className="flex items-center gap-1.5 border-b border-slate-800/80 px-4 py-2">
            {(['all', 'file', 'network', 'process'] as const).map((ch) => (
              <button
                key={ch}
                type="button"
                onClick={() => setChannelFilter(ch)}
                className={`rounded-md px-2.5 py-1 font-mono-tabular text-[11px] uppercase transition ${
                  channelFilter === ch
                    ? 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/40'
                    : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-200'
                }`}
              >
                {ch}
              </button>
            ))}
          </div>

          {/* Scrollable Body */}
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {/* Scout Findings */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-mono-tabular text-[11px] font-semibold tracking-wider text-slate-300 uppercase">
                  Channel Scout Findings ({nodeFindings.length})
                </h3>
                <span className="font-mono-tabular text-[10px] text-slate-500">
                  2-MIN WINDOW SWARM
                </span>
              </div>

              {nodeFindings.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-400">
                  Scouts analyzing populated channel chunks… benign chunks emit 0 findings.
                </div>
              ) : (
                <div className="space-y-2">
                  {nodeFindings.map((f) => {
                    const meta = CHANNEL_META[f.channel]
                    return (
                      <motion.div
                        key={f.finding_id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="rounded-xl border border-red-500/30 bg-red-950/20 p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono-tabular text-[10px] ${meta.color}`}
                          >
                            {meta.label} SCOUT
                          </span>
                          <span className="font-mono-tabular text-[10px] font-semibold text-red-300 uppercase">
                            CONFIDENCE: {f.confidence}
                          </span>
                        </div>
                        <div className="mt-1.5 font-mono-tabular text-xs font-semibold text-red-200">
                          {f.signal}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-slate-300">{f.rationale}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {f.evidence_event_ids.map((eid) => (
                            <button
                              key={eid}
                              type="button"
                              onClick={() => selectEvent(eid)}
                              className={`rounded border px-1.5 py-0.5 font-mono-tabular text-[10px] transition ${
                                selectedEventId === eid
                                  ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-sky-400/50'
                              }`}
                            >
                              {eid}
                            </button>
                          ))}
                        </div>
                      </motion.div>
                    )
                  })}
                </div>
              )}
            </section>

            {/* Telemetry Stream */}
            <section>
              <h3 className="mb-2 font-mono-tabular text-[11px] font-semibold tracking-wider text-slate-300 uppercase">
                Ephemeral Channel Telemetry ({nodeEvents.length})
              </h3>
              <div className="space-y-2">
                {nodeEvents.map((ev) => {
                  const meta = CHANNEL_META[ev.channel]
                  const Icon = meta.icon
                  const isSelected = selectedEventId === ev.event_id
                  return (
                    <button
                      key={ev.event_id}
                      type="button"
                      onClick={() => selectEvent(ev.event_id)}
                      className={`w-full rounded-xl border p-2.5 text-left transition ${
                        isSelected
                          ? 'border-amber-400/70 bg-amber-500/10'
                          : ev.suspicious
                            ? 'border-red-500/35 bg-red-950/15 hover:border-red-400/60'
                            : 'border-slate-800/90 bg-slate-950/60 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono-tabular text-[10px] ${meta.color}`}
                        >
                          <Icon className="h-2.5 w-2.5" />
                          {meta.label}
                        </span>
                        <span className="font-mono-tabular text-[10px] text-slate-400">
                          {ev.event_id} • {ev.event_time.slice(11, 19)}Z
                        </span>
                      </div>
                      <div className="mt-1.5 text-xs font-medium text-slate-100">
                        {ev.summary ?? 'Telemetry event'}
                      </div>
                      <pre className="mt-1 overflow-x-auto font-mono-tabular text-[10px] text-slate-400">
                        {JSON.stringify(ev.payload)}
                      </pre>
                    </button>
                  )
                })}
              </div>
            </section>
          </div>

          {/* Footer CTA to Council */}
          <div className="border-t border-slate-800/90 bg-slate-950/80 px-4 py-3">
            <button
              type="button"
              onClick={() => vegaSource.jumpToStage('council')}
              className="flex w-full items-center justify-between rounded-xl border border-purple-400/40 bg-purple-500/15 px-3.5 py-2 text-xs font-semibold text-purple-200 transition hover:bg-purple-500/25"
            >
              <span>
                {councilSignal
                  ? `Escalate ${councilSignal.severity} to The Council`
                  : 'Preview Council Reasoning'}
              </span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

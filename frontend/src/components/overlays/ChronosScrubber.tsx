import { ChevronDown, ChevronUp, History, Play, SkipBack, SkipForward } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { useVegaStore } from '../../store/useVegaStore'

export function ChronosScrubber() {
  const events = useVegaStore((s) => s.events)
  const chronosExpanded = useVegaStore((s) => s.chronosExpanded)
  const setChronosExpanded = useVegaStore((s) => s.setChronosExpanded)
  const chronosCursorIndex = useVegaStore((s) => s.chronosCursorIndex)
  const setChronosCursorIndex = useVegaStore((s) => s.setChronosCursorIndex)
  const selectNode = useVegaStore((s) => s.selectNode)

  const [replaying, setReplaying] = useState(false)

  const activeIndex =
    chronosCursorIndex !== null && chronosCursorIndex < events.length
      ? chronosCursorIndex
      : events.length > 0
        ? events.length - 1
        : null

  const activeEvent = activeIndex !== null ? events[activeIndex] : null

  useEffect(() => {
    if (!replaying || events.length === 0) return
    const id = window.setInterval(() => {
      const current = useVegaStore.getState().chronosCursorIndex ?? 0
      if (current >= events.length - 1) {
        setReplaying(false)
        return
      }
      setChronosCursorIndex(current + 1)
    }, 900)
    return () => window.clearInterval(id)
  }, [replaying, events.length, setChronosCursorIndex])

  return (
    <div className="fixed inset-x-4 bottom-3 z-30">
      <div className="vega-panel overflow-hidden rounded-2xl">
        {/* Collapsed / Header Bar */}
        <div className="flex h-11 items-center justify-between px-4">
          <button
            type="button"
            onClick={() => setChronosExpanded(!chronosExpanded)}
            className="flex items-center gap-2.5 text-left"
          >
            <History className="h-4 w-4 text-purple-400" />
            <span className="font-mono-tabular text-[11px] font-semibold tracking-[0.18em] text-purple-300 uppercase">
              04 / CHRONOS
            </span>
            <span className="hidden text-xs text-slate-400 sm:inline">
              Forensic Timeline ({events.length} events captured)
            </span>
          </button>

          {/* Mini timeline dots preview */}
          <div className="mx-4 hidden flex-1 items-center gap-1.5 overflow-hidden md:flex">
            {events.map((ev, idx) => (
              <button
                key={ev.event_id}
                type="button"
                title={`${ev.event_id} (${ev.source_id} • ${ev.channel})`}
                onClick={() => {
                  setChronosCursorIndex(idx)
                  setChronosExpanded(true)
                }}
                className={`h-2 flex-1 rounded-full transition ${
                  idx === activeIndex
                    ? 'ring-2 ring-amber-300'
                    : ''
                } ${ev.suspicious ? 'bg-red-500/85' : 'bg-sky-500/45 hover:bg-sky-400/75'}`}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={() => setChronosExpanded(!chronosExpanded)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/80 px-2.5 py-1 font-mono-tabular text-[10px] text-slate-300 hover:border-purple-400/50"
          >
            <span>{chronosExpanded ? 'COLLAPSE' : 'SCRUB TIMELINE'}</span>
            {chronosExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        {/* Expanded Forensic Scrubber */}
        <AnimatePresence>
          {chronosExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="border-t border-slate-800/90 bg-slate-950/85 px-4 py-3"
            >
              {events.length === 0 ? (
                <div className="py-4 text-center text-xs text-slate-400">
                  Waiting for telemetry events to populate Chronos…
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Controls + Slider */}
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          setChronosCursorIndex(Math.max(0, (activeIndex ?? 0) - 1))
                        }
                        className="rounded border border-slate-800 bg-slate-900 p-1.5 text-slate-300 hover:border-purple-400/50"
                        title="Previous event"
                      >
                        <SkipBack className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!replaying && (activeIndex ?? 0) >= events.length - 1) {
                            setChronosCursorIndex(0)
                          }
                          setReplaying(!replaying)
                        }}
                        className="inline-flex items-center gap-1 rounded border border-purple-400/40 bg-purple-500/15 px-2.5 py-1 font-mono-tabular text-[11px] text-purple-200 hover:bg-purple-500/25"
                      >
                        <Play className="h-3 w-3" />
                        <span>{replaying ? 'REPLAYING…' : 'REPLAY'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setChronosCursorIndex(
                            Math.min(events.length - 1, (activeIndex ?? 0) + 1),
                          )
                        }
                        className="rounded border border-slate-800 bg-slate-900 p-1.5 text-slate-300 hover:border-purple-400/50"
                        title="Next event"
                      >
                        <SkipForward className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, events.length - 1)}
                      value={activeIndex ?? 0}
                      onChange={(e) => {
                        setReplaying(false)
                        setChronosCursorIndex(Number(e.target.value))
                      }}
                      className="h-1.5 flex-1 cursor-pointer accent-purple-400"
                    />

                    <span className="font-mono-tabular text-[11px] text-slate-400">
                      {(activeIndex ?? 0) + 1} / {events.length}
                    </span>
                  </div>

                  {/* Selected Event Forensic Card */}
                  {activeEvent && (
                    <div
                      className={`flex flex-col justify-between gap-3 rounded-xl border p-3 md:flex-row md:items-center ${
                        activeEvent.suspicious
                          ? 'border-red-500/40 bg-red-950/20'
                          : 'border-slate-800 bg-slate-900/60'
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-[11px]">
                          <span className="font-bold text-white">{activeEvent.event_id}</span>
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-sky-300">
                            {activeEvent.source_id}
                          </span>
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-purple-300 uppercase">
                            {activeEvent.channel}
                          </span>
                          <span className="text-slate-400">{activeEvent.event_time}</span>
                        </div>
                        <div className="text-xs font-medium text-slate-100">
                          {activeEvent.summary}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <code className="max-w-md truncate rounded bg-black/50 px-2.5 py-1 font-mono-tabular text-[10px] text-slate-300">
                          {JSON.stringify(activeEvent.payload)}
                        </code>
                        <button
                          type="button"
                          onClick={() => selectNode(activeEvent.source_id)}
                          className="shrink-0 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 font-mono-tabular text-[10px] text-slate-200 hover:border-sky-400/50"
                        >
                          Focus {activeEvent.source_id}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

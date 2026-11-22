import { MessageSquareCode, Send, Sparkles, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { SCENARIOS } from '../../data/scenarios'
import { vegaSource } from '../../engine/sourceManager'
import { useVegaStore } from '../../store/useVegaStore'

export function ObserverDrawer() {
  const observerOpen = useVegaStore((s) => s.observerOpen)
  const setObserverOpen = useVegaStore((s) => s.setObserverOpen)
  const observerMessages = useVegaStore((s) => s.observerMessages)
  const dataMode = useVegaStore((s) => s.dataMode)
  const scenarioId = useVegaStore((s) => s.scenarioId)
  const activeWindowId = useVegaStore((s) => s.activeWindowId)
  const councilSignal = useVegaStore((s) => s.councilSignal)
  const nodes = useVegaStore((s) => s.nodes)
  const selectEvent = useVegaStore((s) => s.selectEvent)
  const setChronosExpanded = useVegaStore((s) => s.setChronosExpanded)

  const [input, setInput] = useState('')
  const primaryLiveNode =
    councilSignal?.source_ids[0] ?? nodes.find((n) => n.source_id !== 'vega-core')?.source_id
  const presets =
    dataMode === 'SIMULATED'
      ? SCENARIOS[scenarioId].observerPresets.map((p) => ({ id: p.id, prompt: p.prompt }))
      : [
          ...(primaryLiveNode
            ? [
                {
                  id: 'live-node',
                  prompt: `Summarize telemetry and findings for ${primaryLiveNode} in ${activeWindowId}.`,
                },
              ]
            : []),
          {
            id: 'live-window',
            prompt: `What is the current status of window ${activeWindowId} and preserved evidence?`,
          },
          {
            id: 'live-ttl',
            prompt: 'Verify privacy guarantees and Redis stream TTL retention.',
          },
        ]

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return
    vegaSource.askObserver(input)
    setInput('')
  }

  const handleCitationClick = (eventId: string) => {
    selectEvent(eventId)
    setChronosExpanded(true)
  }

  return (
    <AnimatePresence>
      {observerOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setObserverOpen(false)}
            className="fixed inset-0 z-40 bg-black/55 backdrop-blur-xs"
          />

          <motion.aside
            initial={{ x: 480 }}
            animate={{ x: 0 }}
            exit={{ x: 480 }}
            transition={{ type: 'spring', stiffness: 340, damping: 34 }}
            className="vega-panel fixed top-3 right-3 bottom-3 z-50 flex w-[460px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
              <div>
                <div className="flex items-center gap-2 font-mono-tabular text-[10px] tracking-[0.2em] text-sky-400 uppercase">
                  <MessageSquareCode className="h-3.5 w-3.5" />
                  <span>06 / VEGA CORE — THE OBSERVER</span>
                </div>
                <h2 className="mt-0.5 text-sm font-bold text-white">
                  Conversational Evidence Intelligence
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setObserverOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Suggested Judge Prompts */}
            <div className="border-b border-slate-800/80 bg-slate-950/60 px-4 py-2.5">
              <div className="mb-1.5 flex items-center gap-1 font-mono-tabular text-[10px] text-slate-400 uppercase">
                <Sparkles className="h-3 w-3 text-purple-400" />
                <span>Suggested Queries</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => vegaSource.askObserver(p.prompt)}
                    className="rounded-lg border border-slate-700/80 bg-slate-900/90 px-2.5 py-1 text-left text-[11px] text-slate-200 transition hover:border-sky-400/50 hover:text-white"
                  >
                    {p.prompt}
                  </button>
                ))}
              </div>
            </div>

            {/* Conversation Feed */}
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {observerMessages.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-800 bg-slate-950/40 p-4 text-xs leading-relaxed text-slate-400">
                  Ask VEGA to explain why a node was flagged, inspect competing hypotheses, or
                  verify privacy & TTL guarantees. Every answer links directly to preserved{' '}
                  <span className="font-mono-tabular text-sky-300">event_id</span> evidence.
                </div>
              ) : (
                observerMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`rounded-xl border p-3 text-xs ${
                      msg.role === 'user'
                        ? 'ml-8 border-sky-500/30 bg-sky-950/25 text-sky-100'
                        : 'mr-4 border-slate-800 bg-slate-900/80 text-slate-200'
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between font-mono-tabular text-[10px] text-slate-400">
                      <span>{msg.role === 'user' ? 'OPERATOR' : 'VEGA OBSERVER'}</span>
                      <span>{msg.timestamp}</span>
                    </div>
                    <p className="leading-relaxed">{msg.text}</p>

                    {msg.qa && (
                      <div className="mt-2.5 space-y-2 border-t border-slate-800 pt-2">
                        <ul className="list-disc space-y-1 pl-4 text-[11px] text-slate-300">
                          {msg.qa.summary_bullets.map((b) => (
                            <li key={b}>{b}</li>
                          ))}
                        </ul>

                        {msg.qa.cited_event_ids.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1 pt-1">
                            <span className="font-mono-tabular text-[10px] text-slate-400">
                              EVIDENCE:
                            </span>
                            {msg.qa.cited_event_ids.map((eid) => (
                              <button
                                key={eid}
                                type="button"
                                onClick={() => handleCitationClick(eid)}
                                className="rounded border border-sky-400/35 bg-sky-500/10 px-1.5 py-0.5 font-mono-tabular text-[10px] text-sky-200 hover:border-sky-300"
                              >
                                {eid}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Input */}
            <form
              onSubmit={handleSubmit}
              className="flex items-center gap-2 border-t border-slate-800 bg-slate-950/90 p-3"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  dataMode === 'SIMULATED'
                    ? 'Ask VEGA about subj-042, policies, or evidence…'
                    : 'Ask VEGA about active endpoints, policies, or evidence…'
                }
                className="flex-1 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
              />
              <button
                type="submit"
                className="inline-flex items-center justify-center rounded-xl border border-sky-400/50 bg-sky-500/20 p-2 text-sky-200 hover:bg-sky-500/30"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

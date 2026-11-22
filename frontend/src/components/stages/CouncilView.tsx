import { ArrowLeft, ArrowRight } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { vegaSource } from '../../engine/sourceManager'
import { useVegaEyeState } from '../../store/useVegaEyeState'
import { useVegaStore } from '../../store/useVegaStore'
import { VegaEye } from '../layout/VegaEye'
import { OracleAssessmentPanel } from './OracleAssessmentPanel'

export function CouncilView() {
  const eyeState = useVegaEyeState()
  const stage = useVegaStore((s) => s.stage)
  const councilSignal = useVegaStore((s) => s.councilSignal)
  const selectEvent = useVegaStore((s) => s.selectEvent)
  const setChronosExpanded = useVegaStore((s) => s.setChronosExpanded)
  const setStage = useVegaStore((s) => s.setStage)

  return (
    <AnimatePresence>
      {stage === 'council' && (
        <motion.section
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="absolute inset-0 z-20 flex flex-col overflow-y-auto bg-[#050811]/88 px-6 pt-32 pb-20 backdrop-blur-md"
        >
          {/* Header */}
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
            <div>
              <div className="flex items-center gap-2 font-mono-tabular text-[11px] tracking-[0.22em] text-purple-400 uppercase">
                <VegaEye state={eyeState} className="h-auto w-7 shrink-0" />
                03 / ORACLE — THE COUNCIL
              </div>
              <h1 className="mt-1 text-xl font-bold text-white">
                Autonomous Multi-Agent Deliberation
              </h1>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setStage('panopticon')}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700/80 bg-slate-900/80 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Topology</span>
              </button>

              <button
                type="button"
                onClick={() => vegaSource.jumpToStage('blackout')}
                className="inline-flex items-center gap-2 rounded-xl border border-red-500/50 bg-red-500/15 px-4 py-2 text-xs font-semibold tracking-wider text-red-200 uppercase transition hover:bg-red-500/25"
              >
                <span>Escalate to Warden Gate</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Evidence & Reasoning Grid */}
          <div className="mx-auto mt-6 grid w-full max-w-6xl grid-cols-1 gap-5 lg:grid-cols-12">
            {/* Left: Sentinel Correlator Report */}
            <div className="vega-panel rounded-2xl p-5 lg:col-span-5">
              <header className="truncate border-b border-slate-800/80 pb-3">
                <span className="font-mono-tabular text-[11px] font-semibold tracking-wider text-sky-300/90 uppercase">
                  Sentinel Correlator Handoff{councilSignal && ':'}
                </span>
                {councilSignal && (
                  <span className="ml-1.5 text-[11px] text-slate-500">
                    {councilSignal.finding_refs.length} {councilSignal.finding_refs.length === 1 ? 'finding' : 'findings'}{' '}
                    corroborated {councilSignal.evidence_event_ids.length}{' '}
                    {councilSignal.evidence_event_ids.length === 1 ? 'event' : 'events'}
                  </span>
                )}
              </header>
              {councilSignal ? (
                <div className="mt-5 space-y-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono-tabular text-[11px] text-red-300/80">
                      <span
                        className={councilSignal.severity === 'SEV1' ? 'font-semibold text-red-300' : ''}
                        style={
                          councilSignal.severity === 'SEV1'
                            ? { textShadow: '0 0 8px rgba(248, 113, 113, 0.75), 0 0 18px rgba(239, 68, 68, 0.45)' }
                            : undefined
                        }
                      >
                        {councilSignal.severity}
                      </span>
                      <span className="mx-1.5 text-red-300/40">·</span>
                      {councilSignal.window_id}
                    </span>
                    <span className="truncate font-mono-tabular text-[10px] text-slate-500">
                      {councilSignal.escalation_rule}
                    </span>
                  </div>

                  <div>
                    <h3 className="text-sm font-medium text-slate-100">{councilSignal.summary}</h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{councilSignal.rationale}</p>
                  </div>

                  <div className="border-t border-slate-800 pt-3">
                    <div className="mb-2 flex items-baseline justify-between gap-3">
                      <span className="font-mono-tabular text-[10px] tracking-[0.18em] text-slate-500 uppercase">
                        Preserved evidence
                      </span>
                      <span className="font-mono-tabular text-[10px] text-slate-600">
                        click to inspect in Chronos
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {councilSignal.evidence_event_ids.map((eid) => (
                        <button
                          key={eid}
                          type="button"
                          onClick={() => {
                            selectEvent(eid)
                            setChronosExpanded(true)
                          }}
                          className="rounded border border-slate-800 px-2 py-0.5 font-mono-tabular text-[11px] text-slate-400 transition hover:border-slate-600 hover:text-slate-200"
                        >
                          {eid}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-xs text-slate-400">
                  No SEV1 signal escalated in the current window.
                </p>
              )}
            </div>

            {/* Right: Oracle Contextual Reasoning */}
            <OracleAssessmentPanel />
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  )
}

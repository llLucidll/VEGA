import { ArrowLeft, ArrowRight, BrainCircuit, Eye, Shield } from 'lucide-react'
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
  const oracleAssessment = useVegaStore((s) => s.oracleAssessment)
  const findings = useVegaStore((s) => s.findings)
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

          {/* Triad Visualization */}
          <div className="mx-auto mt-5 w-full max-w-6xl">
            <div className="vega-panel relative overflow-hidden rounded-2xl p-6">
              <svg
                viewBox="0 0 900 170"
                className="pointer-events-none absolute inset-0 h-full w-full opacity-80"
                preserveAspectRatio="none"
              >
                <defs>
                  <linearGradient id="beam-so" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#38bdf8" />
                    <stop offset="100%" stopColor="#a855f7" />
                  </linearGradient>
                  <linearGradient id="beam-ow" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#a855f7" />
                    <stop offset="100%" stopColor="#ef4444" />
                  </linearGradient>
                </defs>

                <motion.path
                  d="M 190 85 C 280 85, 320 85, 410 85"
                  fill="none"
                  stroke="url(#beam-so)"
                  strokeWidth="2.5"
                  strokeDasharray="8 6"
                  animate={{ strokeDashoffset: [0, -28] }}
                  transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
                />
                <motion.path
                  d="M 490 85 C 580 85, 620 85, 710 85"
                  fill="none"
                  stroke="url(#beam-ow)"
                  strokeWidth="2.5"
                  strokeDasharray="8 6"
                  animate={{ strokeDashoffset: [0, -28] }}
                  transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
                />
              </svg>

              <div className="relative z-10 grid grid-cols-1 gap-4 md:grid-cols-3">
                {/* Sentinel Node */}
                <div className="rounded-xl border border-sky-400/40 bg-sky-950/30 p-4">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-2 font-mono-tabular text-xs font-bold tracking-wider text-sky-300">
                      <Eye className="h-4 w-4" />
                      SENTINEL
                    </span>
                    <span className="rounded bg-sky-500/20 px-2 py-0.5 font-mono-tabular text-[10px] text-sky-200">
                      DETECT & CORRELATE
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-300">
                    {councilSignal
                      ? `${findings.length} channel scouts corroborated ${councilSignal.evidence_event_ids.length} events into ${councilSignal.severity}.`
                      : 'Awaiting correlated window signal…'}
                  </p>
                </div>

                {/* Oracle Node */}
                <div className="rounded-xl border border-purple-400/50 bg-purple-950/35 p-4 shadow-[0_0_30px_rgba(168,85,247,0.18)]">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-2 font-mono-tabular text-xs font-bold tracking-wider text-purple-300">
                      <BrainCircuit className="h-4 w-4" />
                      ORACLE
                    </span>
                    <span className="rounded bg-purple-500/20 px-2 py-0.5 font-mono-tabular text-[10px] text-purple-200">
                      CONTEXT & POLICY
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-300">
                    {oracleAssessment
                      ? `Evaluated ${oracleAssessment.cited_policies.length} policies & ruled out benign hypotheses.`
                      : 'Evaluating organizational policies and historical context…'}
                  </p>
                </div>

                {/* Warden Node */}
                <div className="rounded-xl border border-red-500/40 bg-red-950/25 p-4">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-2 font-mono-tabular text-xs font-bold tracking-wider text-red-300">
                      <Shield className="h-4 w-4" />
                      WARDEN
                    </span>
                    <span className="rounded bg-red-500/20 px-2 py-0.5 font-mono-tabular text-[10px] text-red-200">
                      POLICY GATE (DRY-RUN)
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-300">
                    {oracleAssessment
                      ? `Prepared scoped containment: ${oracleAssessment.recommended_action}.`
                      : 'Standing by for Oracle assessment before policy evaluation.'}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Evidence & Reasoning Grid */}
          <div className="mx-auto mt-5 grid w-full max-w-6xl grid-cols-1 gap-5 lg:grid-cols-12">
            {/* Left: Sentinel Correlator Report */}
            <div className="vega-panel rounded-2xl p-5 lg:col-span-5">
              <div className="font-mono-tabular text-[11px] font-semibold tracking-wider text-sky-400 uppercase">
                Sentinel Correlator Handoff
              </div>
              {councilSignal ? (
                <div className="mt-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="rounded border border-red-500/50 bg-red-500/15 px-2 py-0.5 font-mono-tabular text-xs font-bold text-red-300">
                      {councilSignal.severity} • {councilSignal.window_id}
                    </span>
                    <span className="font-mono-tabular text-[10px] text-slate-400">
                      {councilSignal.escalation_rule}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-white">{councilSignal.summary}</h3>
                  <p className="text-xs leading-relaxed text-slate-300">{councilSignal.rationale}</p>

                  <div>
                    <div className="mb-1.5 font-mono-tabular text-[10px] text-slate-400 uppercase">
                      Preserved Evidence References (click to inspect in Chronos)
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
                          className="rounded border border-sky-400/30 bg-sky-500/10 px-2 py-0.5 font-mono-tabular text-[11px] text-sky-200 hover:border-sky-300"
                        >
                          {eid}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-xs text-slate-400">
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

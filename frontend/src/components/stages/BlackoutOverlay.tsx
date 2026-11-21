import { AlertOctagon, ArrowLeft, CheckCircle2, Lock, ShieldAlert, ShieldCheck, Terminal } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { vegaSource } from '../../engine/sourceManager'
import { useVegaStore } from '../../store/useVegaStore'

export function BlackoutOverlay() {
  const stage = useVegaStore((s) => s.stage)
  const wardenDecision = useVegaStore((s) => s.wardenDecision)
  const setStage = useVegaStore((s) => s.setStage)

  const isContained = wardenDecision?.execution_status === 'contained_dry_run'
  const isExecuting = wardenDecision?.execution_status === 'executing'
  const isDenied = wardenDecision?.execution_status === 'denied'

  return (
    <AnimatePresence>
      {stage === 'blackout' && (
        <motion.section
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
          className="absolute inset-0 z-20 flex flex-col overflow-y-auto bg-[#090307]/92 px-6 pt-6 pb-20 backdrop-blur-md"
        >
          {/* Crimson atmospheric sweep */}
          <motion.div
            initial={{ scaleX: 0, opacity: 0.9 }}
            animate={{ scaleX: 1, opacity: 0.22 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
            className="pointer-events-none absolute inset-x-0 top-0 h-64 origin-left bg-gradient-to-b from-red-600/40 via-red-900/15 to-transparent"
          />

          <div className="relative z-10 mx-auto w-full max-w-5xl space-y-5">
            {/* Hero Banner */}
            <motion.div
              initial={{ y: -16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.1 }}
              className={`rounded-2xl border p-6 shadow-[0_0_60px_rgba(239,68,68,0.22)] ${
                isContained
                  ? 'border-emerald-500/50 bg-emerald-950/25'
                  : 'border-red-500/60 bg-red-950/30'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 font-mono-tabular text-xs tracking-[0.24em] text-red-400 uppercase">
                  <AlertOctagon className="h-4 w-4" />
                  <span>05 / WARDEN — BLACKOUT PROTOCOL</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setStage('council')}
                    className="inline-flex items-center gap-1 rounded border border-slate-700/80 bg-slate-900/80 px-2.5 py-0.5 font-mono-tabular text-[11px] text-slate-300 transition hover:border-slate-500 hover:text-white"
                  >
                    <ArrowLeft className="h-3 w-3" />
                    <span>Council</span>
                  </button>
                  <span className="inline-flex items-center gap-1.5 rounded border border-amber-400/40 bg-amber-500/15 px-2.5 py-0.5 font-mono-tabular text-[11px] font-semibold text-amber-200">
                    <Lock className="h-3 w-3" />
                    SIMULATED DRY-RUN • NO LIVE CONTROLS MUTATED
                  </span>
                </div>
              </div>

              <h1 className="mt-3 text-2xl font-bold tracking-tight text-white sm:text-3xl">
                {isContained
                  ? 'VEGA HAS CONTAINED THE THREAT (DRY-RUN)'
                  : isExecuting
                    ? 'VEGA HAS ASSUMED CONTROL — EXECUTING CONTAINMENT'
                    : isDenied
                      ? 'CONTAINMENT HELD BY OPERATOR'
                      : 'VEGA // SEV1 CONTAINMENT GATE READY'}
              </h1>

              <p className="mt-1.5 text-sm text-slate-300">
                {wardenDecision
                  ? `Target: ${wardenDecision.trusted_target_ref} • Scope: ${wardenDecision.scope}`
                  : 'No active SEV1 Warden decision queued.'}
              </p>
            </motion.div>

            {wardenDecision && (
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
                {/* Left: Policy Gate & Authorization */}
                <div className="vega-panel rounded-2xl border-red-500/30 p-5 lg:col-span-6">
                  <div className="flex items-center justify-between">
                    <span className="font-mono-tabular text-[11px] font-semibold tracking-wider text-red-300 uppercase">
                      Warden Policy Gate ({wardenDecision.policy_id})
                    </span>
                    <span className="font-mono-tabular text-[10px] text-slate-400">
                      {wardenDecision.decision_id}
                    </span>
                  </div>

                  <div className="mt-3 rounded-xl border border-slate-800 bg-black/40 p-3">
                    <div className="font-mono-tabular text-[10px] text-slate-400 uppercase">
                      Proposed Bounded Action
                    </div>
                    <div className="mt-1 font-mono-tabular text-xs font-semibold text-red-200">
                      {wardenDecision.proposed_action}
                    </div>
                  </div>

                  <div className="mt-4 space-y-2">
                    {wardenDecision.policy_checks.map((chk) => (
                      <div
                        key={chk.id}
                        className="flex items-start gap-2.5 rounded-xl border border-slate-800/90 bg-slate-950/70 p-2.5"
                      >
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                        <div>
                          <div className="text-xs font-semibold text-slate-100">{chk.label}</div>
                          <div className="text-[11px] text-slate-400">{chk.detail}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Authorization Controls */}
                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    {wardenDecision.execution_status === 'awaiting_authorization' && (
                      <>
                        <button
                          type="button"
                          onClick={() => vegaSource.authorizeContainment()}
                          className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-red-400/70 bg-red-600/85 px-4 py-2.5 text-xs font-bold tracking-wider text-white uppercase shadow-[0_0_25px_rgba(239,68,68,0.45)] transition hover:bg-red-500"
                        >
                          <ShieldAlert className="h-4 w-4" />
                          <span>Authorize Containment (Dry-Run)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => vegaSource.denyContainment()}
                          className="rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-xs font-medium text-slate-300 hover:border-slate-500"
                        >
                          Hold / Deny
                        </button>
                      </>
                    )}

                    {isContained && (
                      <button
                        type="button"
                        onClick={() => setStage('panopticon')}
                        className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-emerald-400/50 bg-emerald-500/20 px-4 py-2.5 text-xs font-semibold tracking-wider text-emerald-200 uppercase hover:bg-emerald-500/30"
                      >
                        <ShieldCheck className="h-4 w-4" />
                        <span>View Isolated Node in Panopticon</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Right: Live Containment Audit Log */}
                <div className="vega-panel flex flex-col rounded-2xl border-red-500/30 p-5 lg:col-span-6">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-2 font-mono-tabular text-[11px] font-semibold tracking-wider text-slate-200 uppercase">
                      <Terminal className="h-3.5 w-3.5 text-red-400" />
                      Live Warden Audit Log
                    </span>
                    <span className="font-mono-tabular text-[10px] text-slate-400">
                      {wardenDecision.approval_ref ?? 'PENDING APPROVAL'}
                    </span>
                  </div>

                  <div className="mt-3 flex-1 space-y-2 overflow-y-auto rounded-xl border border-slate-800/90 bg-black/60 p-3 font-mono-tabular text-[11px]">
                    {wardenDecision.audit_log.map((entry) => {
                      const color =
                        entry.status === 'critical'
                          ? 'text-red-300'
                          : entry.status === 'ok'
                            ? 'text-emerald-300'
                            : entry.status === 'warn'
                              ? 'text-amber-300'
                              : 'text-sky-300'
                      return (
                        <motion.div
                          key={entry.id}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="border-b border-slate-900 pb-2 last:border-none"
                        >
                          <div className="flex items-center gap-2 text-[10px] text-slate-500">
                            <span>{entry.timestamp}</span>
                            <span>•</span>
                            <span className="text-slate-300">{entry.actor}</span>
                          </div>
                          <div className={`mt-0.5 ${color}`}>{entry.message}</div>
                        </motion.div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  )
}

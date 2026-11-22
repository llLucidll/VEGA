import { AlertOctagon, ArrowLeft, CheckCircle2, ShieldAlert, ShieldCheck, Terminal, XCircle } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { vegaSource } from '../../engine/sourceManager'
import { isWardenApprovalExpired, isWardenApprovalPending } from '../../engine/wardenApproval'
import { useVegaStore } from '../../store/useVegaStore'
import { VegaEye } from '../layout/VegaEye'

export function BlackoutOverlay() {
  const stage = useVegaStore((s) => s.stage)
  const dataMode = useVegaStore((s) => s.dataMode)
  const liveStatus = useVegaStore((s) => s.liveStatus)
  const wardenDecision = useVegaStore((s) => s.wardenDecision)
  const wardenRequest = useVegaStore((s) => s.wardenRequest)
  const setStage = useVegaStore((s) => s.setStage)
  const [now, setNow] = useState(() => Date.now())

  const isLive = dataMode === 'LIVE'
  const awaitingApproval = isWardenApprovalPending(wardenDecision)
  const trackApprovalExpiry = isLive && stage === 'blackout' && awaitingApproval
  useEffect(() => {
    if (!trackApprovalExpiry) return
    const tick = () => setNow(Date.now())
    const frame = window.requestAnimationFrame(tick)
    const timer = window.setInterval(tick, 1000)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearInterval(timer)
    }
  }, [trackApprovalExpiry])

  const approvalExpired = isLive && awaitingApproval && isWardenApprovalExpired(wardenDecision, now)
  const requestPending = isLive && wardenRequest?.status === 'pending'
  const requestError = isLive && wardenRequest?.status === 'error' &&
    wardenRequest.decisionId === wardenDecision?.decision_id ? wardenRequest.message : null
  const offline = isLive && liveStatus !== 'connected'
  const approvalDisabled = requestPending || offline || approvalExpired
  const isDryRun = wardenDecision?.dry_run ?? !isLive
  const isAutoJev = Boolean(wardenDecision && !wardenDecision.requires_human_approval)
  const isContained =
    wardenDecision?.execution_status === 'contained' ||
    wardenDecision?.execution_status === 'contained_dry_run'
  const isExecuting = wardenDecision?.execution_status === 'executing'
  const isDenied = wardenDecision?.execution_status === 'denied'
  const containmentStatus = isContained
    ? isAutoJev
      ? isDryRun
        ? 'Auto-contained by Jev (dry run)'
        : 'Auto-contained by Jev — live enforcement active'
      : isDryRun
        ? 'Threat contained in dry run'
        : 'Threat contained — live enforcement active'
    : isExecuting
      ? isDryRun
        ? 'Dry-run containment in progress'
        : 'Executing live containment'
      : isDenied
        ? 'Containment held by operator'
        : approvalExpired
          ? 'Authorization expired'
          : 'Awaiting operator authorization'

  return (
    <AnimatePresence>
      {stage === 'blackout' && (
        <motion.section
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
          aria-labelledby="warden-heading"
          className="vega-blackout absolute inset-0 z-20 flex flex-col overflow-x-hidden overflow-y-auto px-4 pb-20 sm:px-6"
        >
          {/* Crimson atmospheric sweep */}
          <motion.div
            initial={{ scaleX: 0, opacity: 0.9 }}
            animate={{ scaleX: 1, opacity: 0.22 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
            className="pointer-events-none absolute inset-x-0 top-0 h-64 origin-left bg-gradient-to-b from-red-600/40 via-red-900/15 to-transparent"
          />

          <header className="sticky top-0 z-20 -mx-4 flex shrink-0 items-center justify-between gap-3 border-b border-red-500/15 bg-[#09060c]/92 px-4 py-4 backdrop-blur-md sm:-mx-6 sm:px-6 sm:py-5">
            <div className="flex min-w-0 items-center gap-2 font-mono-tabular text-[10px] tracking-[0.16em] text-red-400 uppercase sm:text-xs sm:tracking-[0.24em]">
              <AlertOctagon aria-hidden="true" className="size-4 shrink-0" />
              <span>05 / WARDEN — BLACKOUT PROTOCOL</span>
            </div>
            <button
              type="button"
              onClick={() => setStage('council')}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-700/80 bg-slate-900/80 px-2.5 py-1.5 font-mono-tabular text-[11px] text-slate-300 transition hover:border-slate-500 hover:text-white"
            >
              <ArrowLeft aria-hidden="true" className="size-3" />
              <span>Council</span>
            </button>
          </header>

          <div className="relative z-10 mx-auto mt-10 w-full max-w-5xl space-y-5 sm:mt-12">
            {/* Float the takeover over the topology; only the halo is frosted. */}
            <div className="vega-warden-hero relative p-4 sm:p-6">
              <motion.div
                initial={{ y: -16, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.1 }}
                className="relative"
              >
                {wardenDecision ? (
                  <div className="flex flex-col items-center px-1 py-6 text-center sm:py-8">
                    <VegaEye
                      state="warden"
                      wardenScan
                      className="vega-warden-hero-eye h-auto w-40 max-w-full drop-shadow-[0_0_24px_rgba(248,113,113,0.5)] sm:w-52 lg:w-60"
                    />
                    <h1
                      id="warden-heading"
                      className="vega-warden-heading mt-3 text-balance text-red-50"
                    >
                      VEGA HAS ASSUMED CONTROL
                    </h1>
                    <p role="status" className={`mt-4 font-mono-tabular text-xs tracking-widest uppercase ${isContained ? 'text-emerald-300' : 'text-amber-200'}`}>
                      {containmentStatus}
                    </p>
                    <p className="mt-2 text-sm text-slate-300">
                      Target: {wardenDecision.trusted_target_ref} • Scope: {wardenDecision.scope}
                    </p>
                  </div>
                ) : (
                  <>
                    <h1 id="warden-heading" className="mt-3 text-2xl font-bold tracking-tight text-white sm:text-3xl">
                      VEGA // SEV1 CONTAINMENT GATE READY
                    </h1>
                    <p className="mt-1.5 text-sm text-slate-300">No active SEV1 Warden decision queued.</p>
                  </>
                )}
              </motion.div>
            </div>

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
                        {chk.passed ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                        ) : (
                          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                        )}
                        <div>
                          <div className="text-xs font-semibold text-slate-100">{chk.label}</div>
                          <div className="text-[11px] text-slate-400">{chk.detail}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {wardenDecision.jev_decision && (
                    <div className="mt-4 rounded-xl border border-purple-500/30 bg-purple-950/20 p-3">
                      <div className="flex items-center justify-between font-mono-tabular text-[10px] text-purple-300 uppercase">
                        <span>Jev System One ({wardenDecision.jev_decision.model})</span>
                        <span>
                          {wardenDecision.jev_decision.available
                            ? `conf ${(wardenDecision.jev_decision.confidence * 100).toFixed(0)}%`
                            : 'UNAVAILABLE'}
                        </span>
                      </div>
                      {wardenDecision.jev_decision.available ? (
                        <div className="mt-2 flex flex-wrap gap-1.5 font-mono-tabular text-[10px]">
                          {Object.entries(wardenDecision.jev_decision.probabilities).map(([k, p]) => (
                            <span
                              key={k}
                              className={`rounded border px-1.5 py-0.5 ${
                                k === wardenDecision.jev_decision?.action_choice
                                  ? 'border-purple-400/60 bg-purple-500/20 text-purple-100'
                                  : 'border-slate-800 bg-slate-950/70 text-slate-400'
                              }`}
                            >
                              {k}: {(p * 100).toFixed(0)}%
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-1 text-[11px] text-amber-200">
                          {wardenDecision.jev_decision.error ?? 'Failed closed to human authorization.'}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Authorization Controls */}
                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    {awaitingApproval && (
                      <>
                        <button
                          type="button"
                          disabled={approvalDisabled}
                          onClick={() => vegaSource.authorizeContainment(wardenDecision.decision_id)}
                          className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-red-400/70 bg-red-600/85 px-4 py-2.5 text-xs font-bold tracking-wider text-white uppercase shadow-[0_0_25px_rgba(239,68,68,0.45)] transition enabled:hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none"
                        >
                          <ShieldAlert className="h-4 w-4" />
                          <span>
                            {isDryRun ? 'Authorize Containment (Dry-Run)' : 'Authorize Live Containment'}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={approvalDisabled}
                          onClick={() => vegaSource.denyContainment(wardenDecision.decision_id)}
                          className="rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-xs font-medium text-slate-300 enabled:hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-45"
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
                        <span>View Panopticon</span>
                      </button>
                    )}
                  </div>
                  {requestPending && <p role="status" className="mt-2 text-xs text-slate-300">Submitting to Warden…</p>}
                  {awaitingApproval && offline && (
                    <p className="mt-2 text-xs text-amber-200">Reconnect to the live stream to respond to this decision.</p>
                  )}
                  {requestError && <p role="alert" className="mt-2 text-xs text-amber-200">{requestError}</p>}
                </div>

                {/* Right: Live Containment Audit Log */}
                <div className="vega-panel flex flex-col rounded-2xl border-red-500/30 p-5 lg:col-span-6">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-2 font-mono-tabular text-[11px] font-semibold tracking-wider text-slate-200 uppercase">
                      <Terminal className="h-3.5 w-3.5 text-red-400" />
                      Warden Audit Log
                    </span>
                    <span className="font-mono-tabular text-[10px] text-slate-400">
                      {awaitingApproval
                        ? approvalExpired ? 'EXPIRED' : 'PENDING APPROVAL'
                        : isDenied ? 'DENIED' : wardenDecision.approval_ref ?? 'APPROVED'}
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

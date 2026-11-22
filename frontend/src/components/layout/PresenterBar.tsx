import {
  ArrowRight,
  FastForward,
  Minus,
  Pause,
  Play,
  Plus,
  PlusCircle,
  Radio,
  RotateCcw,
  ShieldCheck,
  Zap,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { flushLiveWindow, switchDataMode, togglePipelinePause, vegaSource } from '../../engine/sourceManager'
import { useVegaStore } from '../../store/useVegaStore'

export function PresenterBar() {
  const presenterOpen = useVegaStore((s) => s.presenterOpen)
  const dataMode = useVegaStore((s) => s.dataMode)
  const isPlaying = useVegaStore((s) => s.isPlaying)
  const pipelinePaused = useVegaStore((s) => s.pipelinePaused)
  const scenarioId = useVegaStore((s) => s.scenarioId)
  const stage = useVegaStore((s) => s.stage)
  const hasFindings = useVegaStore((s) => s.findings.length > 0)
  const chronosExpanded = useVegaStore((s) => s.chronosExpanded)
  const wardenDecision = useVegaStore((s) => s.wardenDecision)
  const zoomPercent = useVegaStore((s) => s.zoomPercent)
  const setZoomPercent = useVegaStore((s) => s.setZoomPercent)

  const nextCueLabel =
    stage === 'panopticon'
      ? hasFindings
        ? 'Next: Inspect Node'
        : dataMode === 'LIVE'
          ? 'Next: Flush Window'
          : 'Next: Inject Anomaly'
      : stage === 'ghost_protocol'
        ? 'Next: The Council'
        : stage === 'council'
          ? chronosExpanded
            ? 'Next: Blackout'
            : 'Next: Chronos'
          : stage === 'blackout'
            ? dataMode === 'SIMULATED' && wardenDecision?.execution_status === 'awaiting_authorization'
              ? 'Next: Authorize'
              : 'Next: Observer'
            : 'Next Cue'

  return (
    <AnimatePresence>
      {presenterOpen && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.18 }}
          className="vega-panel pointer-events-auto absolute inset-x-4 top-full mt-2 ml-auto flex w-fit flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-xs"
        >
          {/* Source Mode Toggle */}
          <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950 p-0.5 font-mono-tabular text-[10px]">
            <button
              type="button"
              onClick={() => switchDataMode('SIMULATED')}
              className={`rounded px-2 py-0.5 transition ${
                dataMode === 'SIMULATED'
                  ? 'bg-amber-500/20 text-amber-200'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              SIMULATED
            </button>
            <button
              type="button"
              onClick={() => switchDataMode('LIVE')}
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 transition ${
                dataMode === 'LIVE'
                  ? 'bg-emerald-500/20 text-emerald-200'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Radio className="h-2.5 w-2.5" />
              LIVE
            </button>
          </div>

          <div className="h-4 w-px bg-slate-800" />

          <button
            type="button"
            onClick={() => vegaSource.advanceCue()}
            className="inline-flex items-center gap-1.5 rounded-md border border-sky-400/60 bg-sky-500/20 px-2.5 py-1 font-semibold text-sky-100 hover:bg-sky-500/30"
          >
            <span>{nextCueLabel}</span>
            <ArrowRight className="h-3 w-3" />
          </button>

          {dataMode === 'SIMULATED' && (
            <>
              <button
                type="button"
                onClick={() => vegaSource.stepNextEvent()}
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200 hover:border-sky-400/50"
                title="Emit one single event without changing stage"
              >
                <PlusCircle className="h-3 w-3 text-sky-400" />
                <span>+1 Event</span>
              </button>

              <button
                type="button"
                onClick={() => vegaSource.injectAnomaly()}
                className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/15 px-2.5 py-1 font-medium text-red-200 hover:bg-red-500/25"
              >
                <Zap className="h-3 w-3" />
                <span>Inject Anomaly</span>
              </button>
            </>
          )}

          {dataMode === 'LIVE' && (
            <button
              type="button"
              onClick={() => void flushLiveWindow()}
              className="inline-flex items-center gap-1 rounded-md border border-cyan-400/40 bg-cyan-500/15 px-2 py-1 font-medium text-cyan-200 hover:bg-cyan-500/25"
              title="Close active backend window and run Sentinel scouts now"
            >
              <span>Flush Window</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => void togglePipelinePause()}
            aria-pressed={pipelinePaused}
            title="Hold VEGA before escalating to Correlator, Council, or Warden"
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium transition ${
              pipelinePaused
                ? 'border-amber-400/60 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30'
                : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-sky-400/50'
            }`}
          >
            {pipelinePaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            <span>{pipelinePaused ? 'Resume Pipeline' : 'Pause Pipeline'}</span>
          </button>

          <button
            type="button"
            onClick={() => vegaSource.jumpToStage('council')}
            className="inline-flex items-center gap-1 rounded-md border border-purple-500/40 bg-purple-500/15 px-2 py-1 text-purple-200 hover:bg-purple-500/25"
          >
            <span>Council</span>
          </button>

          <button
            type="button"
            onClick={() => vegaSource.jumpToStage('blackout')}
            className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-950/50 px-2 py-1 text-red-200 hover:bg-red-500/25"
          >
            <FastForward className="h-3 w-3" />
            <span>Blackout</span>
          </button>

          <div className="h-4 w-px bg-slate-800" />

          {dataMode === 'SIMULATED' && (
            <button
              type="button"
              onClick={() => vegaSource.reset('benign-control')}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium transition ${
                scenarioId === 'benign-control'
                  ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-emerald-400/40'
              }`}
            >
              <ShieldCheck className="h-3 w-3" />
              <span>Benign</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => vegaSource.reset('sev1-exfil')}
            className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-slate-300 hover:border-sky-400/50"
          >
            <RotateCcw className="h-3 w-3" />
            <span>Reset</span>
          </button>

          <button
            type="button"
            onClick={() => vegaSource.setPlaying(!isPlaying)}
            title="Toggle ambient background telemetry particles"
            className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950 px-2 py-1 font-mono-tabular text-[10px] text-slate-400 hover:text-slate-200"
          >
            {isPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            <span>Ambient</span>
          </button>

          <div className="h-4 w-px bg-slate-800" />

          <div
            role="group"
            aria-label="Topology zoom"
            className="flex items-center rounded-md border border-slate-800 bg-slate-950 p-0.5 font-mono-tabular text-[10px]"
          >
            <button
              type="button"
              aria-label="Zoom out"
              title="Zoom out (−)"
              disabled={zoomPercent <= 50}
              onClick={() => setZoomPercent(zoomPercent - 10)}
              className="grid h-6 w-6 place-items-center rounded text-slate-300 hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-35"
            >
              <Minus aria-hidden="true" className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label={`Reset zoom to 100 percent (currently ${zoomPercent} percent)`}
              title="Reset zoom (0)"
              onClick={() => setZoomPercent(100)}
              className="min-w-10 px-1 text-center text-slate-200 hover:text-white"
            >
              {zoomPercent}%
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              title="Zoom in (+)"
              disabled={zoomPercent >= 100}
              onClick={() => setZoomPercent(zoomPercent + 10)}
              className="grid h-6 w-6 place-items-center rounded text-slate-300 hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-35"
            >
              <Plus aria-hidden="true" className="h-3 w-3" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

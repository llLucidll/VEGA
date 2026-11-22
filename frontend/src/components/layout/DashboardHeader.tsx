import { Pause, Play } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { togglePipelinePause } from '../../engine/sourceManager'
import { useVegaEyeState } from '../../store/useVegaEyeState'
import { useVegaStore } from '../../store/useVegaStore'
import { PresenterBar } from './PresenterBar'
import { TelemetryTicker } from './TelemetryTicker'
import { VegaBrand } from './VegaBrand'

interface DashboardHeaderProps {
  onRecenter: () => void
  onHeightChange: (height: number) => void
}

export function DashboardHeader({ onRecenter, onHeightChange }: DashboardHeaderProps) {
  const headerStack = useRef<HTMLDivElement>(null)
  const stage = useVegaStore((s) => s.stage)
  const pipelinePaused = useVegaStore((s) => s.pipelinePaused)
  const wardenActive = useVegaEyeState() === 'warden'
  const showTicker = stage === 'panopticon' || stage === 'ghost_protocol' || stage === 'council'

  useEffect(() => {
    const stack = headerStack.current
    if (!stack) return
    // The stationary ticker can wrap, especially on mobile with reduced motion.
    const observer = new ResizeObserver(() => onHeightChange(stack.offsetHeight))
    observer.observe(stack)
    return () => observer.disconnect()
  }, [onHeightChange])

  return (
    <div ref={headerStack} className={`pointer-events-none absolute inset-x-0 z-30 ${wardenActive ? 'top-30' : 'top-0'}`}>
      {!wardenActive && (
        <header className="vega-dashboard-header pointer-events-auto grid items-center gap-x-4 px-4 py-1.5 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:px-6 md:py-2.5">
          {stage === 'panopticon' && (
            <div className="hidden md:block">
              <div className="flex items-center gap-2">
                <span className="font-mono-tabular text-[10px] tracking-[0.2em] text-sky-400/85">
                  01 /
                </span>
                <span className="font-display text-xs tracking-[0.08em] text-slate-100 uppercase">
                  Sentinel Panopticon
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                <span>Monitoring time-series channels:</span>
                <span className="font-mono-tabular text-[10px] tracking-wider text-slate-300 uppercase">
                  File · Network · Process
                </span>
              </div>
            </div>
          )}

          <div className="justify-self-center md:col-start-2 md:row-start-1">
            <VegaBrand onRecenter={onRecenter} />
          </div>

          <div className="justify-self-end md:col-start-3 md:row-start-1">
            <button
              type="button"
              onClick={() => void togglePipelinePause()}
              aria-pressed={pipelinePaused}
              title={
                pipelinePaused
                  ? 'Resume VEGA autonomous escalation pipeline'
                  : 'Pause VEGA before escalating to Correlator, Council, or Warden'
              }
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono-tabular text-[11px] tracking-wider uppercase backdrop-blur-md transition ${
                pipelinePaused
                  ? 'border-amber-400/70 bg-amber-500/20 text-amber-200 shadow-[0_0_18px_rgba(251,191,36,0.28)] hover:bg-amber-500/30'
                  : 'border-slate-700/80 bg-slate-950/75 text-slate-300 hover:border-sky-400/50 hover:text-white'
              }`}
            >
              {pipelinePaused ? (
                <>
                  <Play aria-hidden="true" className="size-3 fill-current" />
                  <span>Paused · Resume</span>
                </>
              ) : (
                <>
                  <Pause aria-hidden="true" className="size-3" />
                  <span>Pause</span>
                </>
              )}
            </button>
          </div>
        </header>
      )}

      {!wardenActive && showTicker && <TelemetryTicker />}
      <PresenterBar />
    </div>
  )
}

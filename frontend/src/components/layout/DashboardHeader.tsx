import { useEffect, useRef } from 'react'
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
              <div className="font-mono-tabular text-[10px] tracking-widest text-sky-300 uppercase">
                01 / Sentinel Panopticon
              </div>
              <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-slate-300">
                <span>File</span>
                <span>Network</span>
                <span>Process</span>
              </div>
              <div className="mt-1.5 text-[11px] text-slate-400">
                Drag to move · Click to inspect
              </div>
            </div>
          )}

          <div className="justify-self-center md:col-start-2 md:row-start-1">
            <VegaBrand onRecenter={onRecenter} />
          </div>
        </header>
      )}

      {!wardenActive && showTicker && <TelemetryTicker />}
      <PresenterBar />
    </div>
  )
}

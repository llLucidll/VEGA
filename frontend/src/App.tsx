import { useEffect, useRef, useState } from 'react'
import { DashboardHeader } from './components/layout/DashboardHeader'
import { ChronosScrubber } from './components/overlays/ChronosScrubber'
import { ObserverDrawer } from './components/overlays/ObserverDrawer'
import { BlackoutOverlay } from './components/stages/BlackoutOverlay'
import { CouncilView } from './components/stages/CouncilView'
import { GhostProtocolPanel } from './components/stages/GhostProtocolPanel'
import { PanopticonCanvas, type PanopticonHandle } from './components/stages/PanopticonCanvas'
import { switchDataMode, vegaSource } from './engine/sourceManager'
import { useVegaStore } from './store/useVegaStore'

export function App() {
  const topology = useRef<PanopticonHandle>(null)
  const [headerHeight, setHeaderHeight] = useState(0)
  const threatMode = useVegaStore((s) => s.threatMode)
  const wardenDecisionId = useVegaStore((s) => s.wardenDecision?.decision_id)
  const setStage = useVegaStore((s) => s.setStage)

  useEffect(() => {
    // Open the Warden view once per decision; execution updates don't interrupt navigation.
    if (wardenDecisionId) setStage('blackout')
  }, [wardenDecisionId, setStage])

  useEffect(() => {
    // A backend restart should not leave an open dashboard stuck in replay mode.
    switchDataMode('LIVE', true)
    return () => vegaSource.stop()
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const current = useVegaStore.getState().observerOpen
        useVegaStore.getState().setObserverOpen(!current)
      } else if (e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        const current = useVegaStore.getState().presenterOpen
        useVegaStore.getState().setPresenterOpen(!current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      data-threat-mode={threatMode}
      className="relative h-dvh w-full overflow-hidden bg-[#050811] text-slate-100"
    >
      <DashboardHeader
        onHeightChange={setHeaderHeight}
        onRecenter={() => {
          topology.current?.recenter()
          setStage('panopticon')
        }}
      />

      <main className="relative h-full overflow-clip">
        <PanopticonCanvas ref={topology} />
        <GhostProtocolPanel headerHeight={headerHeight} />
        <CouncilView />
        <BlackoutOverlay />
      </main>

      <ChronosScrubber />
      <ObserverDrawer />
    </div>
  )
}

export default App

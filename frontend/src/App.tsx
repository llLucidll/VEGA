import { useEffect } from 'react'
import { PresenterBar } from './components/layout/PresenterBar'
import { TopHud } from './components/layout/TopHud'
import { ChronosScrubber } from './components/overlays/ChronosScrubber'
import { ObserverDrawer } from './components/overlays/ObserverDrawer'
import { BlackoutOverlay } from './components/stages/BlackoutOverlay'
import { CouncilView } from './components/stages/CouncilView'
import { GhostProtocolPanel } from './components/stages/GhostProtocolPanel'
import { PanopticonCanvas } from './components/stages/PanopticonCanvas'
import { vegaSource } from './engine/mockSource'
import { useVegaStore } from './store/useVegaStore'

export function App() {
  const threatMode = useVegaStore((s) => s.threatMode)

  useEffect(() => {
    vegaSource.start('sev1-exfil')
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
      className="relative flex h-screen w-screen flex-col overflow-hidden bg-[#050811] text-slate-100"
    >
      <TopHud />
      <PresenterBar />

      <main className="relative flex-1 overflow-hidden">
        <PanopticonCanvas />
        <GhostProtocolPanel />
        <CouncilView />
        <BlackoutOverlay />
      </main>

      <ChronosScrubber />
      <ObserverDrawer />
    </div>
  )
}

export default App

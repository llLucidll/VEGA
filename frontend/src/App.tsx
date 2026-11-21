import { useEffect } from 'react'
import { PresenterBar } from './components/layout/PresenterBar'
import { ChronosScrubber } from './components/overlays/ChronosScrubber'
import { ObserverDrawer } from './components/overlays/ObserverDrawer'
import { BlackoutOverlay } from './components/stages/BlackoutOverlay'
import { CouncilView } from './components/stages/CouncilView'
import { GhostProtocolPanel } from './components/stages/GhostProtocolPanel'
import { PanopticonCanvas } from './components/stages/PanopticonCanvas'
import { switchDataMode, vegaSource } from './engine/sourceManager'
import { useVegaStore } from './store/useVegaStore'

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

export function App() {
  const threatMode = useVegaStore((s) => s.threatMode)
  const wardenDecisionId = useVegaStore((s) => s.wardenDecision?.decision_id)
  const setStage = useVegaStore((s) => s.setStage)

  useEffect(() => {
    // Open the Warden view once per decision; execution updates don't interrupt navigation.
    if (wardenDecisionId) setStage('blackout')
  }, [wardenDecisionId, setStage])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 500)

    fetch(`${API_BASE}/health`, { signal: controller.signal })
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          switchDataMode('LIVE', true)
        } else {
          switchDataMode('SIMULATED', true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          switchDataMode('SIMULATED', true)
        }
      })
      .finally(() => {
        window.clearTimeout(timeoutId)
      })

    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timeoutId)
      vegaSource.stop()
    }
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
      <PresenterBar />

      <main className="relative h-full overflow-clip">
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

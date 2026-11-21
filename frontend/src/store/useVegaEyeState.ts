import { useVegaStore } from './useVegaStore'

export type VegaEyeState = 'idle' | 'alert' | 'investigating' | 'warden'

export function useVegaEyeState(): VegaEyeState {
  return useVegaStore((state) => {
    if (state.stage === 'blackout' && state.wardenDecision) return 'warden'
    if (state.councilSignal) return 'investigating'
    if (state.threatMode !== 'WATCH' || state.findings.length > 0 || state.events.some((event) => event.suspicious)) {
      return 'alert'
    }
    return 'idle'
  })
}

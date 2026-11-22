import { useVegaStore } from './useVegaStore'

export type VegaEyeState = 'idle' | 'alert' | 'investigating' | 'warden'

export function useVegaEyeState(): VegaEyeState {
  return useVegaStore((state) => {
    if (state.stage === 'blackout' && state.wardenDecision) return 'warden'
    const clearedByOracle =
      state.threatMode === 'WATCH' &&
      state.wardenDecision === null &&
      Boolean(state.oracleAssessment?.verdicts?.length) &&
      state.oracleAssessment!.verdicts!.every((v) => v.verdict === 'NO_ACTION') &&
      state.nodes.every((n) => n.status === 'healthy' || n.status === 'isolated') &&
      !state.findings.some((f) => f.window_id !== state.councilSignal?.window_id)
    if (clearedByOracle) return 'idle'
    if (state.councilSignal) return 'investigating'
    if (state.threatMode !== 'WATCH' || state.findings.length > 0 || state.events.some((event) => event.suspicious)) {
      return 'alert'
    }
    return 'idle'
  })
}

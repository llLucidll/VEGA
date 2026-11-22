import type { ScenarioId, VegaStage } from '../contracts/vega'
import { useVegaStore } from '../store/useVegaStore'
import type { VegaDataSource } from './dataSource'
import { LiveStreamSource } from './liveSource'
import { mockSource } from './mockSource'

const liveSource = new LiveStreamSource()

function activeSource(): VegaDataSource {
  return useVegaStore.getState().dataMode === 'LIVE' ? liveSource : mockSource
}

export function switchDataMode(mode: 'SIMULATED' | 'LIVE', force = false) {
  const current = useVegaStore.getState().dataMode
  if (current === mode && !force) return
  activeSource().stop()
  useVegaStore.getState().setDataMode(mode)
  activeSource().start()
}

export async function flushLiveWindow() {
  if (useVegaStore.getState().dataMode === 'LIVE') {
    await liveSource.flushWindow()
  }
}

export const vegaSource: VegaDataSource = {
  get mode() {
    return activeSource().mode
  },
  start(scenarioId?: ScenarioId) {
    activeSource().start(scenarioId)
  },
  stop() {
    activeSource().stop()
  },
  reset(scenarioId?: ScenarioId) {
    activeSource().reset(scenarioId)
  },
  setPlaying(playing: boolean) {
    activeSource().setPlaying(playing)
  },
  setSpeed(multiplier: number) {
    activeSource().setSpeed(multiplier)
  },
  jumpToStage(stage: VegaStage) {
    activeSource().jumpToStage(stage)
  },
  injectAnomaly() {
    activeSource().injectAnomaly()
  },
  stepNextEvent() {
    activeSource().stepNextEvent()
  },
  advanceCue() {
    activeSource().advanceCue()
  },
  authorizeContainment(decisionId) {
    activeSource().authorizeContainment(decisionId)
  },
  denyContainment(decisionId) {
    activeSource().denyContainment(decisionId)
  },
  askObserver(prompt: string) {
    activeSource().askObserver(prompt)
  },
}

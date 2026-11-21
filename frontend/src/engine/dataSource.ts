import type { ScenarioId, VegaStage } from '../contracts/vega'

export interface VegaDataSource {
  readonly mode: 'SIMULATED' | 'LIVE'
  start(scenarioId?: ScenarioId): void
  stop(): void
  reset(scenarioId?: ScenarioId): void
  setPlaying(playing: boolean): void
  setSpeed(multiplier: number): void
  jumpToStage(stage: VegaStage): void
  injectAnomaly(): void
  stepNextEvent(): void
  advanceCue(): void
  authorizeContainment(): void
  denyContainment(): void
  askObserver(prompt: string): void
}

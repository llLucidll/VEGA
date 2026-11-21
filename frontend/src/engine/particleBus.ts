import type { Channel } from '../contracts/vega'

export interface TelemetryParticle {
  id: number
  from: string
  to: string
  channel: Channel
  suspicious: boolean
  progress: number // 0..1
  speed: number // progress per second
}

let nextParticleId = 1
const activeParticles: TelemetryParticle[] = []

export const particleBus = {
  spawn(from: string, to: string, channel: Channel, suspicious = false) {
    if (activeParticles.length > 140) {
      activeParticles.shift()
    }
    activeParticles.push({
      id: nextParticleId++,
      from,
      to,
      channel,
      suspicious,
      progress: 0,
      speed: suspicious ? 0.72 : 0.48 + Math.random() * 0.22,
    })
  },

  step(dtSeconds: number): TelemetryParticle[] {
    for (let i = activeParticles.length - 1; i >= 0; i--) {
      const p = activeParticles[i]
      p.progress += p.speed * dtSeconds
      if (p.progress >= 1) {
        activeParticles.splice(i, 1)
      }
    }
    return activeParticles
  },

  clear() {
    activeParticles.length = 0
  },
}

import type { MonitoredNode, StoredEvent } from '../contracts/vega'

const RATE_WINDOW_MS = 60_000
const ONLINE_WINDOW_MS = 120_000

type EventSample = Pick<StoredEvent, 'source_id'> & { ingestedAt: number }

export function sampleTelemetry(events: readonly StoredEvent[]) {
  let latestIngest = -Infinity
  let flagged = 0
  const samples = events.map(({ source_id, suspicious, ingested_at }): EventSample => {
    const ingestedAt = Date.parse(ingested_at)
    if (Number.isFinite(ingestedAt)) latestIngest = Math.max(latestIngest, ingestedAt)
    if (suspicious) flagged += 1
    return { source_id, ingestedAt }
  })
  return { samples, latestIngest, captured: events.length, flagged }
}

export function measureTelemetry(
  samples: readonly EventSample[],
  nodes: readonly MonitoredNode[],
  asOf: number,
  mode: 'SIMULATED' | 'LIVE',
) {
  const recentSources = new Set<string>()
  let eventsPerMinute = 0
  for (const sample of samples) {
    const age = asOf - sample.ingestedAt
    if (!Number.isFinite(age) || age < 0) continue
    if (age < RATE_WINDOW_MS) eventsPerMinute += 1
    if (mode === 'LIVE' && age < ONLINE_WINDOW_MS) recentSources.add(sample.source_id)
  }

  let monitored = 0
  let online = 0
  for (const node of nodes) {
    if (node.cluster === 'core') continue
    monitored += 1
    if (node.status === 'isolated') continue
    if (mode === 'SIMULATED' ? node.heartbeat_age_sec * 1000 < ONLINE_WINDOW_MS : recentSources.has(node.source_id)) {
      online += 1
    }
  }

  return { eventsPerMinute, online, monitored }
}

export function formatTtl(seconds: number) {
  const remaining = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`
}

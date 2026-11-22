import assert from 'node:assert/strict'
import { test } from 'node:test'
import { packTopology, spacePentagramTopology } from '../src/engine/topologyLayout.ts'

const hubId = 'vega-core'
const makeBounds = (count) => new Map([
  [hubId, { width: 208, height: 208 }],
  ...Array.from({ length: count }, (_, index) => [
    `vm-${index}`,
    { width: 108 + (index % 6) * 32, height: 36 + (index % 3) * 9 },
  ]),
])

function assertSeparation(positions, bounds, margin = 0) {
  const entries = [...positions]
  for (const [i, [id, a]] of entries.entries()) {
    for (const [otherId, b] of entries.slice(0, i)) {
      const boxA = bounds.get(id)
      const boxB = bounds.get(otherId)
      assert.ok(
        Math.abs(a.x - b.x) >= (boxA.width + boxB.width) / 2 + margin - 1e-8 ||
        Math.abs(a.y - b.y) >= (boxA.height + boxB.height) / 2 + margin - 1e-8,
        `${id} overlaps ${otherId}`,
      )
    }
  }
}

test('all endpoints fit on pentagram strokes while the hub stays fixed', () => {
  assert.equal(spacePentagramTopology(new Map()).positions.size, 0)
  const tips = Array.from({ length: 5 }, (_, i) => {
    const angle = Math.PI / 2 + i * 2 * Math.PI / 5
    return { x: Math.cos(angle), y: Math.sin(angle) }
  })
  for (const count of [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 32, 128]) {
    const bounds = makeBounds(count)
    const { positions, radius } = spacePentagramTopology(bounds)
    assert.equal(positions.size, count + 1)
    assert.deepEqual(positions.get(hubId), { x: 0, y: 0 })
    assertSeparation(positions, bounds, 20)

    const endpoints = [...positions.values()].slice(1).map(({ x, y }) => ({ x: x / radius, y: y / radius }))
    for (const point of endpoints) {
      assert.ok(tips.some((a, i) => {
        const b = tips[(i + 2) % 5]
        const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
        return Math.abs(cross) < 1e-8 && Math.hypot(point.x, point.y) <= 1 + 1e-8
      }))
    }
    if (count >= 5) {
      for (const tip of tips) assert.ok(endpoints.some(({ x, y }) => Math.hypot(x - tip.x, y - tip.y) < 1e-8))
    }
  }
})

test('a growing roster expands the star without depending on arrival order', () => {
  const before = spacePentagramTopology(makeBounds(3))
  const bounds = makeBounds(12)
  const after = spacePentagramTopology(bounds)
  assert.notDeepEqual(before.positions.get('vm-1'), after.positions.get('vm-1'))
  assert.ok(after.radius > before.radius)
  assert.deepEqual(after, spacePentagramTopology(new Map([...bounds].reverse())))
})

test('manual dragging keeps the hub and cards separated', () => {
  const bounds = makeBounds(11)
  const { positions } = spacePentagramTopology(bounds)
  const dragged = packTopology(positions, bounds, { id: 'vm-1', point: positions.get('vm-2') })
  assert.deepEqual(dragged.get('vm-1'), positions.get('vm-2'))
  assert.notDeepEqual(dragged.get('vm-2'), positions.get('vm-2'))
  assert.deepEqual(dragged.get(hubId), { x: 0, y: 0 })
  assertSeparation(dragged, bounds)
})

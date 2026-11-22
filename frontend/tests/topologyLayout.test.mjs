import assert from 'node:assert/strict'
import { test } from 'node:test'
import { packTopology, spaceTopology } from '../src/engine/topologyLayout.ts'

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

test('the hub is fixed and endpoints share a radius and evenly spaced angles', () => {
  assert.equal(spaceTopology(new Map()).size, 0)
  for (const count of [0, 1, 2, 3, 7, 11, 32, 128]) {
    const bounds = makeBounds(count)
    const positions = spaceTopology(bounds)
    assert.equal(positions.size, count + 1)
    assert.deepEqual(positions.get(hubId), { x: 0, y: 0 })
    assertSeparation(positions, bounds, 20)

    const endpoints = [...positions.values()].slice(1)
    if (!endpoints.length) continue
    const radius = Math.hypot(endpoints[0].x, endpoints[0].y)
    const chord = 2 * radius * Math.sin(Math.PI / count)
    for (const [i, point] of endpoints.entries()) {
      assert.ok(Math.abs(Math.hypot(point.x, point.y) - radius) < 1e-8)
      if (count > 1) {
        const next = endpoints[(i + 1) % count]
        assert.ok(Math.abs(Math.hypot(next.x - point.x, next.y - point.y) - chord) < 1e-8)
      }
    }
  }
})

test('a growing roster expands and rebalances the ring', () => {
  const before = spaceTopology(makeBounds(3))
  const after = spaceTopology(makeBounds(12))
  assert.notDeepEqual(before.get('vm-1'), after.get('vm-1'))
  assert.ok(Math.abs(after.get('vm-0').y) > Math.abs(before.get('vm-0').y))
})

test('manual dragging keeps the hub and cards separated', () => {
  const bounds = makeBounds(11)
  const positions = spaceTopology(bounds)
  const dragged = packTopology(positions, bounds, { id: 'vm-1', point: positions.get('vm-2') })
  assert.deepEqual(dragged.get('vm-1'), positions.get('vm-2'))
  assert.notDeepEqual(dragged.get('vm-2'), positions.get('vm-2'))
  assert.deepEqual(dragged.get(hubId), { x: 0, y: 0 })
  assertSeparation(dragged, bounds)
})

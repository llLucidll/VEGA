import assert from 'node:assert/strict'
import { test } from 'node:test'
import { drawTopologyDots } from '../src/engine/drawTopologyDots.ts'

const turn = 2 * Math.PI

// Capture the mark centers and bar vectors from the batched Canvas path without a browser.
function marksAt(width, height, origin, zoom, seconds) {
  const paths = []
  const pathClass = globalThis.Path2D
  globalThis.Path2D = class {
    moveTo(x, y) { this.start = { x, y } }
    arc(x, y) { paths.push({ x, y, kind: 'dot' }) }
    lineTo(x, y) {
      paths.push({
        x: (x + this.start.x) / 2, y: (y + this.start.y) / 2, kind: 'bar',
        dx: x - this.start.x, dy: y - this.start.y,
      })
    }
  }
  try {
    const ctx = { save() {}, restore() {}, stroke() {} }
    drawTopologyDots(ctx, width, height, origin, zoom, { x: 0, y: 0, strength: 0, motion: 0 }, seconds)
  } finally {
    globalThis.Path2D = pathClass
  }
  return paths
}

const ringAt = (marks, origin, radius) => marks.filter(({ x, y }) =>
  Math.abs(Math.hypot(x - origin.x, y - origin.y) - radius) < 1e-6,
)
const bearing = ({ x, y }, origin) => Math.atan2(y - origin.y, x - origin.x)
const largestGap = (ring, origin) => {
  const angles = ring.map((dot) => bearing(dot, origin)).sort((a, b) => a - b)
  return Math.max(...angles.map((a, i) => (angles[i + 1] ?? angles[0] + turn) - a))
}

test('two dotted arcs alternate with a complete dashed ring while neighbors counter-rotate', () => {
  const origin = { x: 700, y: 700 }
  const initial = marksAt(1400, 1400, origin, 1, 0)
  const later = marksAt(1400, 1400, origin, 1, 10)
  const speeds = []
  for (let i = 0; i < 6; i++) {
    const radius = 130 + 100 * i
    const before = ringAt(initial, origin, radius)
    const after = ringAt(later, origin, radius)
    assert.equal(before.length, after.length)
    assert.ok(before.length > 0)
    const bars = i % 3 === 2
    assert.ok(before.every((mark) => mark.kind === (bars ? 'bar' : 'dot')))
    const gap = largestGap(before, origin)
    if (bars) {
      assert.ok(Math.abs(gap - turn / before.length) < 1e-6)
      for (const { x, y, dx, dy } of before) {
        assert.ok(Math.abs((x - origin.x) * dx + (y - origin.y) * dy) < 1e-6)
        const length = Math.hypot(dx, dy)
        assert.ok(Math.abs(length - 8) < 1e-6)
        // Even at 50% zoom, the space between dashes is wider than a dash.
        assert.ok(radius * Math.sin(gap / 2) > 2 * length)
      }
    } else {
      assert.ok(gap > turn / 4)
    }
    assert.ok(Math.abs(largestGap(after, origin) - gap) < 1e-6)
    const shift = bearing(after[0], origin) - bearing(before[0], origin)
    const radians = Math.atan2(Math.sin(shift), Math.cos(shift))
    assert.equal(Math.sign(radians), i % 2 === 0 ? 1 : -1)
    assert.ok(Math.abs(radians) > 0.16 && Math.abs(radians) < 0.3)
    speeds.push(Math.abs(radians).toFixed(5))
  }
  assert.equal(new Set(speeds).size, speeds.length)
})

test('pan and zoom keep arc geometry and gaps attached to the same world center', () => {
  const origin = { x: 1100, y: 600 }
  const width = 340
  const height = 220
  for (const seconds of [0, 45, 380, 630]) {
    for (const zoom of [1, 0.5]) {
      const key = ({ x, y, kind }) => `${kind} ${x.toFixed(5)} ${y.toFixed(5)}`
      const inViewport = ({ x, y }) => x >= 0 && x <= width && y >= 0 && y <= height
      const full = marksAt(2400, 1600, origin, zoom, seconds).filter(inViewport).map(key).sort()
      const culled = marksAt(width, height, origin, zoom, seconds).filter(inViewport).map(key).sort()
      assert.ok(full.length > 0)
      assert.deepEqual(culled, full)
    }
  }
})

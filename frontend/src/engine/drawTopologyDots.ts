import type { Point } from './topologyLayout'

const DOT_STEP = 36
const DOT_RADIUS = 1.35

export interface TopologyHover extends Point {
  strength: number
  motion: number
}

function addRing(path: Pick<Path2D, 'moveTo' | 'arc'>, x: number, y: number, radius: number) {
  path.moveTo(x + radius, y)
  path.arc(x, y, radius, 0, Math.PI * 2)
}

export function drawTopologyDots(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  origin: Point,
  zoom: number,
  hover: TopologyHover,
) {
  const step = DOT_STEP * zoom
  const firstX = (origin.x % step) - step
  const firstY = (origin.y % step) - step
  const base = new Path2D()
  const radius = 106 + 48 * hover.motion
  const reacting = hover.strength > 0.01

  ctx.save()
  ctx.lineWidth = 0.8

  for (let y = firstY; y <= height + step; y += step) {
    for (let x = firstX; x <= width + step; x += step) {
      const dx = x - hover.x
      const dy = y - hover.y
      const distance = reacting && Math.abs(dx) < radius && Math.abs(dy) < radius
        ? Math.hypot(dx, dy)
        : radius
      if (distance >= radius) {
        addRing(base, x, y, DOT_RADIUS)
        continue
      }

      // Nearby rings grow slightly and push radially away from the cursor.
      const influence = hover.strength * (1 - distance / radius) ** 1.5
      const push = (22 + 8 * hover.motion) * influence / Math.max(14, distance)
      const size = DOT_RADIUS + (2.3 + 0.5 * hover.motion) * influence
      const clearCenter = 1 - hover.strength * Math.max(0, 1 - distance / 18)
      const opacity = (0.15 + 0.7 * influence) * clearCenter
      ctx.strokeStyle = `rgba(${Math.round(139 + 116 * influence)}, ${Math.round(174 + 81 * influence)}, ${Math.round(205 + 50 * influence)}, ${opacity})`
      ctx.beginPath()
      addRing(ctx, x + dx * push, y + dy * push, size)
      ctx.stroke()
    }
  }

  ctx.strokeStyle = 'rgba(139, 174, 205, 0.15)'
  ctx.stroke(base)
  ctx.restore()
}

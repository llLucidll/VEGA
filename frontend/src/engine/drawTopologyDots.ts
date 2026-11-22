import type { Point } from './topologyLayout'

const FIRST_RING = 130
const RING_STEP = 100
const DOT_STEP = 54
const DOT_RADIUS = 1.35
const DOT_OPACITY = 0.19
const TURN = Math.PI * 2
const VIEW_MARGIN = 36

export interface TopologyHover extends Point {
  strength: number
  motion: number
}

function addRing(path: Pick<Path2D, 'moveTo' | 'arc'>, x: number, y: number, radius: number) {
  path.moveTo(x + radius, y)
  path.arc(x, y, radius, 0, TURN)
}

export function drawTopologyDots(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  origin: Point,
  zoom: number,
  hover: TopologyHover,
) {
  // Bound the visible rings and their angles with a circle around the viewport.
  // This keeps panning cheap even when VEGA-CORE is far offscreen.
  const dxToView = width / 2 - origin.x
  const dyToView = height / 2 - origin.y
  const viewDistance = Math.hypot(dxToView, dyToView)
  const viewRadius = Math.hypot(width / 2 + VIEW_MARGIN, height / 2 + VIEW_MARGIN)
  const viewAngle = Math.atan2(dyToView, dxToView)
  const halfArc = viewDistance > viewRadius ? Math.asin(viewRadius / viewDistance) : Math.PI
  const firstIndex = Math.max(0, Math.ceil(((viewDistance - viewRadius) / zoom - FIRST_RING) / RING_STEP))
  const lastIndex = Math.floor(((viewDistance + viewRadius) / zoom - FIRST_RING) / RING_STEP)
  const base = new Path2D()
  const radius = 106 + 48 * hover.motion
  const reacting = hover.strength > 0.01

  ctx.save()
  ctx.lineWidth = 0.8

  for (let ring = firstIndex; ring <= lastIndex; ring++) {
    const worldRadius = FIRST_RING + ring * RING_STEP
    const screenRadius = worldRadius * zoom
    const dots = Math.round(TURN * worldRadius / DOT_STEP)
    const angleStep = TURN / dots
    const phase = (ring % 2) * 0.5 // Stagger adjacent rings instead of drawing spokes.
    const start = halfArc === Math.PI ? 0 : Math.ceil((viewAngle - halfArc) / angleStep - phase)
    const end = halfArc === Math.PI ? dots - 1 : Math.floor((viewAngle + halfArc) / angleStep - phase)
    for (let i = start; i <= end; i++) {
      const angle = (i + phase) * angleStep
      const x = origin.x + screenRadius * Math.cos(angle)
      const y = origin.y + screenRadius * Math.sin(angle)
      if (x < -VIEW_MARGIN || x > width + VIEW_MARGIN || y < -VIEW_MARGIN || y > height + VIEW_MARGIN) continue

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
      const opacity = (DOT_OPACITY + 0.7 * influence) * clearCenter
      ctx.strokeStyle = `rgba(${Math.round(139 + 116 * influence)}, ${Math.round(174 + 81 * influence)}, ${Math.round(205 + 50 * influence)}, ${opacity})`
      ctx.beginPath()
      addRing(ctx, x + dx * push, y + dy * push, size)
      ctx.stroke()
    }
  }

  ctx.strokeStyle = `rgba(139, 174, 205, ${DOT_OPACITY})`
  ctx.stroke(base)
  ctx.restore()
}

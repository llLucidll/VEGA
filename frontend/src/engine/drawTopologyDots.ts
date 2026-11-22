import type { Point } from './topologyLayout'

const FIRST_RING = 130
const RING_STEP = 100
const MARK_STEP = 54
const DOT_RADIUS = 1.35
const DASH_HALF_LENGTH = 4
const MARK_OPACITY = 0.19
const TURN = Math.PI * 2
const ARC_FRACTION = 0.68
const PHASE_STEP = TURN * 0.381966 // Golden-angle staggering keeps the gaps from lining up.
const VIEW_MARGIN = 36

export interface TopologyHover extends Point {
  strength: number
  motion: number
}

function addMark(
  path: Pick<Path2D, 'moveTo' | 'lineTo' | 'arc'>,
  x: number,
  y: number,
  tangentialBar: boolean,
  tangentX: number,
  tangentY: number,
  grow = 0,
) {
  if (tangentialBar) {
    const halfLength = DASH_HALF_LENGTH + grow
    const dx = tangentX * halfLength
    const dy = tangentY * halfLength
    path.moveTo(x - dx, y - dy)
    path.lineTo(x + dx, y + dy)
  } else {
    const radius = DOT_RADIUS + grow
    path.moveTo(x + radius, y)
    path.arc(x, y, radius, 0, TURN)
  }
}

export function drawTopologyDots(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  origin: Point,
  zoom: number,
  hover: TopologyHover,
  orbitSeconds: number,
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
    const marks = Math.round(TURN * worldRadius / MARK_STEP)
    const angleStep = TURN / marks
    const bars = ring % 3 === 2
    const arcMarks = bars ? marks : Math.floor(marks * ARC_FRACTION)
    const direction = ring % 2 === 0 ? 1 : -1 // Positive angles turn clockwise on canvas.
    const speed = 0.017 + 0.010 * ring / (ring + 4) // Radians per second; bounded for distant rings.
    const phase = (ring * PHASE_STEP + orbitSeconds * speed * direction) % TURN
    const fullAngularRange = halfArc === Math.PI
    const start = fullAngularRange ? 0 : Math.ceil((viewAngle - halfArc - phase) / angleStep)
    const end = fullAngularRange ? arcMarks - 1 : Math.floor((viewAngle + halfArc - phase) / angleStep)
    for (let i = start; i <= end; i++) {
      // A culled angular span can wrap around the ring; the gap still follows its rotation.
      if (!bars && !fullAngularRange && ((i % marks) + marks) % marks >= arcMarks) continue
      const angle = i * angleStep + phase
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const x = origin.x + screenRadius * cos
      const y = origin.y + screenRadius * sin
      if (x < -VIEW_MARGIN || x > width + VIEW_MARGIN || y < -VIEW_MARGIN || y > height + VIEW_MARGIN) continue

      const dx = x - hover.x
      const dy = y - hover.y
      const distance = reacting && Math.abs(dx) < radius && Math.abs(dy) < radius
        ? Math.hypot(dx, dy)
        : radius
      if (distance >= radius) {
        addMark(base, x, y, bars, -sin, cos)
        continue
      }

      // Nearby marks grow slightly and push radially away from the cursor.
      const influence = hover.strength * (1 - distance / radius) ** 1.5
      const push = (22 + 8 * hover.motion) * influence / Math.max(14, distance)
      const grow = (2.3 + 0.5 * hover.motion) * influence
      const clearCenter = 1 - hover.strength * Math.max(0, 1 - distance / 18)
      const opacity = (MARK_OPACITY + 0.7 * influence) * clearCenter
      ctx.strokeStyle = `rgba(${Math.round(139 + 116 * influence)}, ${Math.round(174 + 81 * influence)}, ${Math.round(205 + 50 * influence)}, ${opacity})`
      ctx.beginPath()
      addMark(ctx, x + dx * push, y + dy * push, bars, -sin, cos, grow)
      ctx.stroke()
    }
  }

  ctx.strokeStyle = `rgba(139, 174, 205, ${MARK_OPACITY})`
  ctx.stroke(base)
  ctx.restore()
}

import { PENTAGRAM_OUTLINE, type Point } from './topologyLayout'

/** Decorative geometry only; actual telemetry links are drawn separately. */
export function drawTopologyPentagram(ctx: CanvasRenderingContext2D, origin: Point, radius: number) {
  ctx.save()
  ctx.translate(origin.x, origin.y)

  ctx.beginPath()
  // Visit every second outer tip, skipping the outline's inner vertices.
  for (let i = 0; i < 5; i++) {
    const { x, y } = PENTAGRAM_OUTLINE[(i * 4) % PENTAGRAM_OUTLINE.length]
    if (i === 0) ctx.moveTo(x * radius, y * radius)
    else ctx.lineTo(x * radius, y * radius)
  }
  ctx.closePath()
  ctx.lineWidth = 1.25
  ctx.strokeStyle = 'rgba(139, 174, 205, 0.28)'
  ctx.stroke()

  ctx.restore()
}

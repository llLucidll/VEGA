export interface Point {
  x: number
  y: number
}

export interface NodeBounds {
  width: number
  height: number
}

type PlacedNode = Point & NodeBounds

const NODE_GAP = 8
const HUB_ID = 'vega-core'
const MIN_ORBIT_RADIUS = 210
const ORBIT_GAP = 20

/** Place every measured endpoint on one ring, with equal angles and a fixed hub. */
export function spaceTopology(bounds: ReadonlyMap<string, NodeBounds>): Map<string, Point> {
  const hub = bounds.get(HUB_ID)
  const positions = new Map<string, Point>(hub ? [[HUB_ID, { x: 0, y: 0 }]] : [])
  const endpoints = [...bounds].filter(([id]) => id !== HUB_ID)
  const step = (2 * Math.PI) / endpoints.length
  const startAngle = endpoints.length === 2 ? 0 : -Math.PI / 2
  const slots = endpoints.map(([id, box], i) => {
    const angle = startAngle + i * step
    return { id, box, x: Math.cos(angle), y: Math.sin(angle) }
  })

  let radius = MIN_ORBIT_RADIUS
  const includeClearance = (a: Point & { box: NodeBounds }, b: Point & { box: NodeBounds }) => {
    const gapX = (a.box.width + b.box.width) / 2 + ORBIT_GAP
    const gapY = (a.box.height + b.box.height) / 2 + ORBIT_GAP
    // The cards only need separation along one axis. With unit-circle slots,
    // each center difference scales directly with the shared ring radius.
    const minimum = Math.min(gapX / Math.abs(a.x - b.x), gapY / Math.abs(a.y - b.y))
    radius = Math.max(radius, Math.ceil(minimum))
  }

  for (const [i, slot] of slots.entries()) {
    if (hub) includeClearance(slot, { x: 0, y: 0, box: hub })
    for (let j = 0; j < i; j++) includeClearance(slot, slots[j])
  }

  for (const { id, x, y } of slots) positions.set(id, { x: radius * x, y: radius * y })
  return positions
}

function nearestFreePosition(desired: Point, bounds: NodeBounds, placed: PlacedNode[]): Point {
  // Each placed card excludes this rectangle of possible centers for the next card.
  const obstacles = placed.map((other) => {
    const dx = (bounds.width + other.width) / 2 + NODE_GAP
    const dy = (bounds.height + other.height) / 2 + NODE_GAP
    return { left: other.x - dx, right: other.x + dx, top: other.y - dy, bottom: other.y + dy }
  })
  const isFree = (x: number, y: number) =>
    obstacles.every(({ left, right, top, bottom }) => x <= left || x >= right || y <= top || y >= bottom)
  if (isFree(desired.x, desired.y)) return desired

  // The closest valid point lies at the desired coordinate or on an obstacle
  // boundary along each axis. Unlike a spring, this never renders intersections.
  const xs = [desired.x, ...obstacles.flatMap(({ left, right }) => [left, right])]
  const ys = [desired.y, ...obstacles.flatMap(({ top, bottom }) => [top, bottom])]
  let nearest = { x: Math.min(...xs), y: desired.y }
  let best = (nearest.x - desired.x) ** 2
  for (const x of xs) {
    const dx2 = (x - desired.x) ** 2
    if (dx2 >= best) continue
    for (const y of ys) {
      const distance = dx2 + (y - desired.y) ** 2
      if (distance < best && isFree(x, y)) {
        nearest = { x, y }
        best = distance
      }
    }
  }
  return nearest
}

/** Plan a layout in world coordinates using each card's unscaled size. */
export function packTopology(
  desired: ReadonlyMap<string, Point>,
  bounds: ReadonlyMap<string, NodeBounds>,
  dragging?: { id: string; point: Point },
): Map<string, Point> {
  const positions = new Map<string, Point>()
  const placed: PlacedNode[] = []

  const place = (id: string, point: Point) => {
    const box = bounds.get(id)
    if (!box) return
    const position = nearestFreePosition(point, box, placed)
    positions.set(id, position)
    placed.push({ ...position, ...box })
  }

  // The hub stays fixed. The dragged card takes precedence over its neighbors.
  if (desired.has(HUB_ID)) place(HUB_ID, { x: 0, y: 0 })
  if (dragging && dragging.id !== HUB_ID && desired.has(dragging.id)) place(dragging.id, dragging.point)
  for (const [id, point] of desired) {
    if (!positions.has(id)) place(id, point)
  }
  return positions
}

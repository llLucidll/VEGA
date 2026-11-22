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
const MIN_PENTAGRAM_RADIUS = 210
const LAYOUT_GAP = 20
const PENTAGRAM_TIPS = 5
const PENTAGRAM_INNER_RATIO = (3 - Math.sqrt(5)) / 2

// Downward tip first, then clockwise. The inner vertices are the intersections
// of the pentagram's chords, so the slots sit on its strokes, not on fake links.
export const PENTAGRAM_OUTLINE: readonly Point[] = Array.from({ length: 2 * PENTAGRAM_TIPS }, (_, i) => {
  const angle = Math.PI / 2 + i * Math.PI / PENTAGRAM_TIPS
  const radius = i % 2 ? PENTAGRAM_INNER_RATIO : 1
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) }
})

/** Fill the star's tips, then subdivide its perimeter as the roster grows. */
export function spacePentagramTopology(bounds: ReadonlyMap<string, NodeBounds>) {
  const endpoints = [...bounds.keys()].filter((id) => id !== HUB_ID).sort()
  const smallRosters: readonly (readonly number[])[] = [[], [0], [2, 8], [0, 4, 6], [2, 4, 6, 8]]
  const slots = smallRosters[endpoints.length]?.map((i) => PENTAGRAM_OUTLINE[i]) ??
    Array.from({ length: PENTAGRAM_TIPS }, (_, tip) => {
      // Each section gets either floor(n/5) or ceil(n/5) cards, including its tip.
      const count = Math.floor((tip + 1) * endpoints.length / PENTAGRAM_TIPS) -
        Math.floor(tip * endpoints.length / PENTAGRAM_TIPS)
      return Array.from({ length: count }, (_, i) => {
        const offset = 2 * i / count
        const start = 2 * tip + Math.floor(offset)
        const fraction = offset % 1
        const a = PENTAGRAM_OUTLINE[start]
        const b = PENTAGRAM_OUTLINE[(start + 1) % PENTAGRAM_OUTLINE.length]
        return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction }
      })
    }).flat()
  return fitSlots(bounds, endpoints.map((id, i) => ({ id, ...slots[i] })))
}

function fitSlots(bounds: ReadonlyMap<string, NodeBounds>, slots: (Point & { id: string })[]) {
  const hub = bounds.get(HUB_ID)
  const positions = new Map<string, Point>(hub ? [[HUB_ID, { x: 0, y: 0 }]] : [])
  const measured = slots.map((slot) => ({ ...slot, box: bounds.get(slot.id)! }))
  let radius = MIN_PENTAGRAM_RADIUS
  const includeClearance = (a: Point & { box: NodeBounds }, b: Point & { box: NodeBounds }) => {
    const gapX = (a.box.width + b.box.width) / 2 + LAYOUT_GAP
    const gapY = (a.box.height + b.box.height) / 2 + LAYOUT_GAP
    // The cards only need separation along one axis. The slot coordinates
    // scale uniformly so clearance does not distort the underlying shape.
    const minimum = Math.min(gapX / Math.abs(a.x - b.x), gapY / Math.abs(a.y - b.y))
    radius = Math.max(radius, Math.ceil(minimum))
  }

  for (const [i, slot] of measured.entries()) {
    if (hub) includeClearance(slot, { x: 0, y: 0, box: hub })
    for (let j = 0; j < i; j++) includeClearance(slot, measured[j])
  }

  for (const { id, x, y } of slots) positions.set(id, { x: radius * x, y: radius * y })
  return { positions, radius }
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

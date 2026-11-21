import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import { Lock, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MonitoredNode } from '../../contracts/vega'
import { drawTopologyDots, type TopologyHover } from '../../engine/drawTopologyDots'
import { particleBus } from '../../engine/particleBus'
import { packTopology, type NodeBounds, type Point } from '../../engine/topologyLayout'
import { useVegaEyeState } from '../../store/useVegaEyeState'
import { useVegaStore } from '../../store/useVegaStore'
import { VegaBrand } from '../layout/VegaBrand'
import { VegaEye } from '../layout/VegaEye'

interface LayoutNode {
  id: string
  x: number
  y: number
  fx?: number
  fy?: number
}

interface LayoutLink {
  source: string | LayoutNode
  target: string | LayoutNode
}

type CanvasDrag =
  | { kind: 'pan'; pointerId: number; last: Point }
  | { kind: 'node'; pointerId: number; nodeId: string; start: Point; offset: Point; moving: boolean }

function computeStaticLayoutFromKey(topologyKey: string): Map<string, { x: number; y: number }> {
  const [nodesPart = '', edgesPart = ''] = topologyKey.split('|')
  const nodeSpecs = nodesPart
    .split(',')
    .filter(Boolean)
    .map((item) => {
      const [id, cluster] = item.split(':')
      return { id, cluster }
    })
  const edgeSpecs = edgesPart
    .split(',')
    .filter(Boolean)
    .map((item) => {
      const [from, to] = item.split('>')
      return { from, to }
    })

  const simNodes: LayoutNode[] = nodeSpecs.map((n, idx) => {
    if (n.id === 'vega-core') {
      return { id: n.id, x: 0, y: 0, fx: 0, fy: 0 }
    }
    const angle = (idx / Math.max(1, nodeSpecs.length - 1)) * Math.PI * 2
    const radius = n.cluster === 'eng' ? 210 : n.cluster === 'ops' ? 250 : 280
    return {
      id: n.id,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    }
  })

  const simLinks: LayoutLink[] = edgeSpecs.map((e) => ({ source: e.from, target: e.to }))

  const sim = forceSimulation<LayoutNode>(simNodes)
    .force(
      'link',
      forceLink<LayoutNode, LayoutLink>(simLinks)
        .id((d) => d.id)
        .distance((l) => {
          const s = typeof l.source === 'string' ? l.source : l.source.id
          const t = typeof l.target === 'string' ? l.target : l.target.id
          return s === 'vega-core' || t === 'vega-core' ? 215 : 145
        })
        .strength(0.65),
    )
    .force('charge', forceManyBody().strength(-520))
    .force('collide', forceCollide(64))
    .force('center', forceCenter(0, 0))
    .stop()

  for (let i = 0; i < 160; i++) {
    sim.tick()
  }

  const map = new Map<string, { x: number; y: number }>()
  for (const n of simNodes) {
    map.set(n.id, { x: n.x, y: n.y })
  }
  return map
}

export function PanopticonCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nodeElRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const pan = useRef({ x: 0, y: 0 })
  const positionsRef = useRef(new Map<string, Point>())

  const eyeState = useVegaEyeState()
  const nodes = useVegaStore((s) => s.nodes)
  const edges = useVegaStore((s) => s.edges)
  const stage = useVegaStore((s) => s.stage)
  const selectedNodeId = useVegaStore((s) => s.selectedNodeId)
  const selectNode = useVegaStore((s) => s.selectNode)
  const setStage = useVegaStore((s) => s.setStage)
  const events = useVegaStore((s) => s.events)

  const [size, setSize] = useState({ width: 1280, height: 720 })

  const topologyKey = `${nodes.map((n) => `${n.source_id}:${n.cluster}`).join(',')}|${edges.map((e) => `${e.from}>${e.to}`).join(',')}`
  const basePositions = useMemo(() => computeStaticLayoutFromKey(topologyKey), [topologyKey])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = containerRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!el || !canvas || !ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = size.width * dpr
    canvas.height = size.height * dpr

    const origin = { x: size.width / 2, y: size.height / 2 }
    const camera = { x: 0, y: 0, zoom: 1, panWeight: 1 }
    const hover: TopologyHover = { x: 0, y: 0, strength: 0, motion: 0 }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let hoverTarget: Point | null = null
    let drag: CanvasDrag | null = null
    let suppressPointerClick = false
    let target: { id: string; point: Point } | undefined
    let needsLayout = true
    const bounds = new Map<string, NodeBounds>()
    const measureCards = new ResizeObserver(() => { needsLayout = true })
    for (const card of nodeElRefs.current.values()) measureCards.observe(card)

    const canInteract = () => useVegaStore.getState().stage === 'panopticon'
    const movePan = (dx: number, dy: number) => {
      let limitX = size.width / 2
      let limitY = size.height / 2
      for (const { x, y } of positionsRef.current.values()) {
        limitX = Math.max(limitX, Math.abs(x) + 64)
        limitY = Math.max(limitY, Math.abs(y) + 64)
      }
      pan.current.x = Math.max(-limitX, Math.min(limitX, pan.current.x + dx))
      pan.current.y = Math.max(-limitY, Math.min(limitY, pan.current.y + dy))
    }

    const onWheel = (event: WheelEvent) => {
      if (!canInteract() || event.ctrlKey || event.metaKey) return
      event.preventDefault()
      if (drag) return
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1
      const horizontal = event.shiftKey && event.deltaX === 0
      movePan((horizontal ? event.deltaY : event.deltaX) * scale, horizontal ? 0 : event.deltaY * scale)
    }

    const localPoint = (event: PointerEvent): Point => {
      const rect = el.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    const toWorld = (point: Point): Point => ({
      x: (point.x - origin.x) / camera.zoom,
      y: (point.y - origin.y) / camera.zoom,
    })
    const getButton = (event: PointerEvent) =>
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null

    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || drag) return
      suppressPointerClick = false
      if (!canInteract()) return
      hoverTarget = null
      const button = getButton(event)
      const point = localPoint(event)
      if (button) {
        const id = button.dataset.nodeId
        const position = id && positionsRef.current.get(id)
        if (!id || id === 'vega-core' || !position) return
        const world = toWorld(point)
        drag = {
          kind: 'node',
          pointerId: event.pointerId,
          nodeId: id,
          start: point,
          offset: { x: position.x - world.x, y: position.y - world.y },
          moving: false,
        }
        return
      }
      el.setPointerCapture(event.pointerId)
      drag = { kind: 'pan', pointerId: event.pointerId, last: point }
      el.dataset.dragging = 'true'
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!canInteract()) return
      const point = localPoint(event)
      if (!drag) {
        if (event.buttons === 0 && event.pointerType !== 'touch' && !getButton(event)) {
          if (!hoverTarget) {
            hover.x = point.x
            hover.y = point.y
          }
          hoverTarget = point
        } else {
          hoverTarget = null
        }
        return
      }
      if (drag.pointerId !== event.pointerId) return
      if (drag.kind === 'pan') {
        movePan(drag.last.x - point.x, drag.last.y - point.y)
        drag.last = point
        return
      }
      if (!drag.moving) {
        if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < 5) return
        // Capture only after the threshold so a normal click still reaches the card.
        el.setPointerCapture(event.pointerId)
        drag.moving = true
        suppressPointerClick = true
        nodeElRefs.current.get(drag.nodeId)?.setAttribute('data-moving', 'true')
        el.dataset.dragging = 'true'
      }
      const world = toWorld(point)
      target = { id: drag.nodeId, point: { x: world.x + drag.offset.x, y: world.y + drag.offset.y } }
    }

    const endDrag = (pointerId: number) => {
      if (drag?.pointerId !== pointerId) return
      if (drag.kind === 'node') nodeElRefs.current.get(drag.nodeId)?.removeAttribute('data-moving')
      drag = null
      delete el.dataset.dragging
    }
    const onPointerEnd = (event: PointerEvent) => endDrag(event.pointerId)
    const onLostPointerCapture = (event: PointerEvent) => {
      if (event.target === el) endDrag(event.pointerId)
    }
    const onPointerLeave = (event: PointerEvent) => {
      hoverTarget = null
      if (drag && !el.hasPointerCapture(event.pointerId)) endDrag(event.pointerId)
    }
    const onClickCapture = (event: MouseEvent) => {
      // A moved card can still be under the release point. Don't inspect it on drop.
      if (!suppressPointerClick || event.detail === 0) return
      suppressPointerClick = false
      event.preventDefault()
      event.stopPropagation()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== el || !canInteract() || drag || event.altKey || event.ctrlKey || event.metaKey) return
      switch (event.key) {
        case 'ArrowLeft':
          movePan(-48, 0)
          break
        case 'ArrowRight':
          movePan(48, 0)
          break
        case 'ArrowUp':
          movePan(0, -48)
          break
        case 'ArrowDown':
          movePan(0, 48)
          break
        case 'Home':
          pan.current = { x: 0, y: 0 }
          break
        default:
          return
      }
      event.preventDefault()
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerleave', onPointerLeave)
    el.addEventListener('pointerup', onPointerEnd)
    el.addEventListener('pointercancel', onPointerEnd)
    el.addEventListener('lostpointercapture', onLostPointerCapture)
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('click', onClickCapture, true)

    let rafId = 0
    let lastTime = performance.now()

    const render = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000)
      lastTime = now

      if (needsLayout) {
        bounds.clear()
        for (const [id, card] of nodeElRefs.current) {
          bounds.set(id, { width: card.offsetWidth, height: card.offsetHeight })
        }
      }
      if (needsLayout || target) {
        const desired = new Map<string, Point>()
        for (const [id, seed] of basePositions) desired.set(id, positionsRef.current.get(id) ?? seed)
        positionsRef.current = packTopology(desired, bounds, target)
        needsLayout = false
        target = undefined
      }
      const positions = positionsRef.current
      const state = useVegaStore.getState()
      if (state.stage !== 'panopticon') hoverTarget = null
      const isGhost = state.stage === 'ghost_protocol'
      const focusId = state.selectedNodeId ?? 'vm-a'
      const focusPos = positions.get(focusId)

      // Smooth camera target: zoom into selected node and shift left to leave room for Ghost Protocol drawer
      const targetZoom = isGhost ? 1.42 : 1
      const targetX = isGhost && focusPos ? focusPos.x + 130 : 0
      const targetY = isGhost && focusPos ? focusPos.y : 0

      const lerp = 1 - Math.exp(-6 * dt)
      camera.x += (targetX - camera.x) * lerp
      camera.y += (targetY - camera.y) * lerp
      camera.zoom += (targetZoom - camera.zoom) * lerp
      // Keep input responsive while smoothly blending into and out of node inspection.
      camera.panWeight += ((isGhost ? 0 : 1) - camera.panWeight) * lerp
      const cameraX = camera.x + pan.current.x * camera.panWeight
      const cameraY = camera.y + pan.current.y * camera.panWeight

      ctx.save()
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, size.width, size.height)

      origin.x = size.width / 2 - cameraX * camera.zoom
      origin.y = size.height / 2 - cameraY * camera.zoom
      const toScreen = (wx: number, wy: number) => ({
        sx: origin.x + wx * camera.zoom,
        sy: origin.y + wy * camera.zoom,
      })

      const hoverEase = 1 - Math.exp(-18 * dt)
      const targetPoint = !drag && !reducedMotion.matches ? hoverTarget : null
      let motion = 0
      if (targetPoint) {
        const dx = targetPoint.x - hover.x
        const dy = targetPoint.y - hover.y
        motion = Math.min(1, Math.hypot(dx, dy) / 60)
        hover.x += dx * hoverEase
        hover.y += dy * hoverEase
      }
      hover.strength = reducedMotion.matches
        ? 0
        : hover.strength + ((targetPoint ? 1 : 0) - hover.strength) * hoverEase
      hover.motion += (motion - hover.motion) * hoverEase
      drawTopologyDots(ctx, size.width, size.height, origin, camera.zoom, hover)
      const coreScreen = toScreen(0, 0)

      // Subtle orbital radar rings around vega-core
      for (const r of [130, 230, 330]) {
        ctx.beginPath()
        ctx.arc(coreScreen.sx, coreScreen.sy, r * camera.zoom, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.07)'
        ctx.lineWidth = 1
        ctx.setLineDash([4, 8])
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Draw edges
      for (const edge of state.edges) {
        const p1 = positions.get(edge.from)
        const p2 = positions.get(edge.to)
        if (!p1 || !p2) continue
        const s1 = toScreen(p1.x, p1.y)
        const s2 = toScreen(p2.x, p2.y)

        const fromNode = state.nodes.find((n) => n.source_id === edge.from)
        const isIsolated = fromNode?.status === 'isolated'

        ctx.beginPath()
        ctx.moveTo(s1.sx, s1.sy)
        ctx.lineTo(s2.sx, s2.sy)

        if (isIsolated) {
          ctx.strokeStyle = 'rgba(100, 116, 139, 0.18)'
          ctx.setLineDash([4, 6])
          ctx.lineWidth = 1
        } else if (edge.anomalous) {
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)'
          ctx.lineWidth = 2
        } else {
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.18)'
          ctx.lineWidth = 1.1
        }
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Draw expanding alert pulse rings on elevated/compromised nodes
      for (const node of state.nodes) {
        if (node.status !== 'elevated' && node.status !== 'compromised') continue
        const pos = positions.get(node.source_id)
        if (!pos) continue
        const s = toScreen(pos.x, pos.y)
        const phase = ((now / 1000) % 1.6) / 1.6
        const radius = (22 + phase * 54) * camera.zoom
        ctx.beginPath()
        ctx.arc(s.sx, s.sy, radius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(239, 68, 68, ${(1 - phase) * 0.65})`
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // Draw animated telemetry particles
      const particles = particleBus.step(dt)
      for (const p of particles) {
        const p1 = positions.get(p.from)
        const p2 = positions.get(p.to)
        if (!p1 || !p2) continue
        const wx = p1.x + (p2.x - p1.x) * p.progress
        const wy = p1.y + (p2.y - p1.y) * p.progress
        const s = toScreen(wx, wy)

        const color = p.suspicious
          ? '#ef4444'
          : p.channel === 'file'
            ? '#38bdf8'
            : p.channel === 'network'
              ? '#22d3ee'
              : '#818cf8'

        ctx.save()
        ctx.beginPath()
        ctx.arc(s.sx, s.sy, p.suspicious ? 4.2 : 2.8, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.shadowColor = color
        ctx.shadowBlur = p.suspicious ? 16 : 10
        ctx.fill()
        ctx.restore()
      }

      ctx.restore()

      // Sync HTML node badge positions without React re-renders
      for (const node of state.nodes) {
        const el = nodeElRefs.current.get(node.source_id)
        const pos = positions.get(node.source_id)
        if (!el || !pos) continue
        const { sx, sy } = toScreen(pos.x, pos.y)
        el.style.transform = `translate3d(${sx}px, ${sy}px, 0) translate(-50%, -50%)`
      }

      rafId = window.requestAnimationFrame(render)
    }

    rafId = window.requestAnimationFrame(render)
    return () => {
      window.cancelAnimationFrame(rafId)
      measureCards.disconnect()
      if (drag) {
        const pointerId = drag.pointerId
        endDrag(pointerId)
        if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
      }
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerleave', onPointerLeave)
      el.removeEventListener('pointerup', onPointerEnd)
      el.removeEventListener('pointercancel', onPointerEnd)
      el.removeEventListener('lostpointercapture', onLostPointerCapture)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('click', onClickCapture, true)
    }
  }, [basePositions, size])

  const handleNodeClick = (node: MonitoredNode) => {
    if (node.source_id === 'vega-core') return
    selectNode(node.source_id)
    if (stage === 'panopticon') {
      setStage('ghost_protocol')
    }
  }

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Topology canvas"
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home"
      tabIndex={0}
      className="relative h-full w-full touch-none cursor-grab overflow-clip select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-300 data-[dragging=true]:cursor-grabbing"
    >
      <VegaBrand
        onRecenter={() => {
          pan.current = { x: 0, y: 0 }
          setStage('panopticon')
        }}
      />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Top-left Panopticon Telemetry Legend */}
      <div className="pointer-events-none absolute top-32 right-4 left-4 z-10 xl:top-4 xl:right-auto">
        <div className="vega-panel rounded-lg px-3 py-2">
          <div className="font-mono-tabular text-[10px] tracking-[0.2em] text-sky-400 uppercase">
            01 / SENTINEL PANOPTICON
          </div>
          <div className="mt-0.5 text-xs text-slate-300">
            {nodes.length - 1} monitored endpoints • 3 Redis channel streams (
            <span className="font-mono-tabular text-sky-300">file</span>,{' '}
            <span className="font-mono-tabular text-cyan-300">network</span>,{' '}
            <span className="font-mono-tabular text-indigo-300">process</span>)
          </div>
          <div className="mt-1.5 flex items-center gap-3 font-mono-tabular text-[10px] text-slate-400">
            <span>EVENTS INGESTED: {events.length}</span>
            <span>•</span>
            <span>CLICK TO INSPECT · DRAG TO MOVE</span>
          </div>
        </div>
      </div>

      {/* Interactive HTML Node Badges synced to Canvas coordinates */}
      <div className="absolute inset-0 z-0">
        {nodes.map((node) => {
          const isCore = node.source_id === 'vega-core'
          const isSelected = selectedNodeId === node.source_id
          const isAlert = node.status === 'elevated' || node.status === 'compromised'
          const isIsolated = node.status === 'isolated'

          const ringClass = isCore
            ? 'vega-core'
            : isIsolated
              ? 'border-slate-600/70 bg-slate-950/90 text-slate-400'
              : isAlert
                ? 'border-red-500/90 bg-red-950/85 shadow-[0_0_26px_rgba(239,68,68,0.5)]'
                : isSelected
                  ? 'border-sky-300 bg-slate-900/95 shadow-[0_0_20px_rgba(56,189,248,0.35)]'
                  : 'border-slate-700/80 bg-slate-950/85 hover:border-sky-400/60'

          return (
            <button
              key={node.source_id}
              ref={(el) => {
                if (el) nodeElRefs.current.set(node.source_id, el)
                else nodeElRefs.current.delete(node.source_id)
              }}
              type="button"
              data-node-id={node.source_id}
              data-core-state={isCore ? eyeState : undefined}
              aria-disabled={isCore || undefined}
              tabIndex={isCore ? -1 : undefined}
              onClick={() => handleNodeClick(node)}
              className={`group absolute top-0 left-0 flex items-center gap-2 border backdrop-blur-md ${ringClass} ${
                isCore
                  ? 'size-40 cursor-default flex-col justify-center rounded-full px-5 text-center transition-[background-color,border-color,box-shadow] motion-reduce:transition-none'
                  : `rounded-xl px-2.5 py-1.5 text-left transition-colors ${stage === 'panopticon' ? 'cursor-grab data-[moving=true]:cursor-grabbing' : 'cursor-pointer'}`
              }`}
            >
              {isCore ? (
                <VegaEye state={eyeState} className="h-auto w-22 shrink-0" />
              ) : (
                <div className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-black/40">
                  {isIsolated ? (
                    <ShieldOff className="size-3.5 text-slate-400" />
                  ) : isAlert ? (
                    <ShieldAlert className="size-3.5 text-red-400" />
                  ) : (
                    <ShieldCheck className="size-3.5 text-sky-400" />
                  )}
                </div>
              )}

              <div className="leading-tight">
                <div className={`flex items-center gap-1.5 ${isCore ? 'justify-center' : ''}`}>
                  <span className={`font-mono-tabular font-semibold text-slate-100 ${isCore ? 'text-xs tracking-wide uppercase' : 'text-[11px]'}`}>
                    {node.source_id}
                  </span>
                  {node.identity_sealed && (
                    <span
                      title="Employee identity sealed in separate Red Team store"
                      className="inline-flex items-center gap-0.5 rounded bg-slate-800/90 px-1 py-0.5 font-mono-tabular text-[9px] text-slate-400"
                    >
                      <Lock className="h-2 w-2" />
                      {node.pseudonym}
                    </span>
                  )}
                </div>
                <div className={`text-[10px] text-slate-400 ${isCore ? 'mt-1 text-balance' : ''}`}>
                  {isIsolated ? 'ISOLATED (DRY-RUN)' : node.role}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

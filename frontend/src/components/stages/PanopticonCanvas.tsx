import { Lock, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import vegaCoreBlue from '../../assets/vega-core-idle.png'
import vegaCoreGreen from '../../assets/vega-core-alert.png'
import vegaCorePurple from '../../assets/vega-core-council.png'
import vegaCoreRed from '../../assets/vega-core-warden.png'
import type { MonitoredNode } from '../../contracts/vega'
import { drawTopologyDots, type TopologyHover } from '../../engine/drawTopologyDots'
import { particleBus } from '../../engine/particleBus'
import { packTopology, spaceTopology, type NodeBounds, type Point } from '../../engine/topologyLayout'
import { useVegaEyeState } from '../../store/useVegaEyeState'
import { useVegaStore } from '../../store/useVegaStore'
import { VegaEye } from '../layout/VegaEye'

type CanvasDrag =
  | { kind: 'pan'; pointerId: number; last: Point }
  | { kind: 'node'; pointerId: number; nodeId: string; start: Point; offset: Point; moving: boolean }

const DEFAULT_ZOOM = 100
const ZOOM_STEP = 10

const CORE_ARTWORK = {
  idle: vegaCoreGreen,
  alert: vegaCoreBlue,
  investigating: vegaCorePurple,
  warden: vegaCoreRed,
}

export interface PanopticonHandle {
  recenter: () => void
}

export function PanopticonCanvas({ ref }: { ref: Ref<PanopticonHandle> }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nodeElRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const pan = useRef({ x: 0, y: 0 })
  const orbitSeconds = useRef(0)
  const positionsRef = useRef(new Map<string, Point>())
  const layoutIds = useRef<string[]>([])
  const manualLayout = useRef(false)

  const eyeState = useVegaEyeState()
  const wardenCore = eyeState === 'warden'
  const dataMode = useVegaStore((s) => s.dataMode)
  const wardenDecision = useVegaStore((s) => s.wardenDecision)
  const nodes = useVegaStore((s) => s.nodes)
  const stage = useVegaStore((s) => s.stage)
  const selectedNodeId = useVegaStore((s) => s.selectedNodeId)
  const selectNode = useVegaStore((s) => s.selectNode)
  const setStage = useVegaStore((s) => s.setStage)
  const [size, setSize] = useState({ width: 1280, height: 720 })

  useImperativeHandle(ref, () => ({
    recenter: () => {
      pan.current = { x: 0, y: 0 }
    },
  }), [])

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
    const camera = { x: 0, y: 0, zoom: useVegaStore.getState().zoomPercent / DEFAULT_ZOOM, panWeight: 1 }
    const hover: TopologyHover = { x: 0, y: 0, strength: 0, motion: 0 }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let hoverTarget: Point | null = null
    let drag: CanvasDrag | null = null
    let suppressPointerClick = false
    let target: { id: string; point: Point } | undefined
    let needsLayout = true
    let measuredNodes: MonitoredNode[] | undefined
    const bounds = new Map<string, NodeBounds>()
    const measureCards = new ResizeObserver(() => { needsLayout = true })

    const canInteract = () => useVegaStore.getState().stage === 'panopticon'
    const movePan = (dx: number, dy: number) => {
      let limitX = size.width / (2 * camera.zoom)
      let limitY = size.height / (2 * camera.zoom)
      for (const { x, y } of positionsRef.current.values()) {
        limitX = Math.max(limitX, Math.abs(x) + 64)
        limitY = Math.max(limitY, Math.abs(y) + 64)
      }
      pan.current.x = Math.max(-limitX, Math.min(limitX, pan.current.x + dx / camera.zoom))
      pan.current.y = Math.max(-limitY, Math.min(limitY, pan.current.y + dy / camera.zoom))
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
        case '-': {
          const s = useVegaStore.getState()
          s.setZoomPercent(s.zoomPercent - ZOOM_STEP)
          break
        }
        case '=':
        case '+': {
          const s = useVegaStore.getState()
          s.setZoomPercent(s.zoomPercent + ZOOM_STEP)
          break
        }
        case '0':
          useVegaStore.getState().setZoomPercent(DEFAULT_ZOOM)
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

      const state = useVegaStore.getState()
      // Wait for React to mount new cards, and finish any drag before rebalancing.
      if (!drag && !target && state.nodes !== measuredNodes) {
        const ids = state.nodes.map((node) => node.source_id).sort()
        if (ids.every((id) => nodeElRefs.current.has(id))) {
          const rosterChanged =
            ids.length !== layoutIds.current.length || ids.some((id, i) => id !== layoutIds.current[i])
          if (!measuredNodes || rosterChanged) {
            measureCards.disconnect()
            for (const card of nodeElRefs.current.values()) measureCards.observe(card)
            needsLayout = true
          }
          if (rosterChanged) {
            layoutIds.current = ids
            manualLayout.current = false
          }
          measuredNodes = state.nodes
        }
      }

      if (needsLayout) {
        bounds.clear()
        for (const id of layoutIds.current) {
          const card = nodeElRefs.current.get(id)
          if (card) bounds.set(id, { width: card.offsetWidth, height: card.offsetHeight })
        }
      }
      if (needsLayout || target) {
        if (target) manualLayout.current = true
        positionsRef.current = manualLayout.current
          ? packTopology(positionsRef.current, bounds, target)
          : spaceTopology(bounds)
        needsLayout = false
        target = undefined
      }
      const positions = positionsRef.current
      if (state.stage !== 'panopticon') hoverTarget = null
      const isGhost = state.stage === 'ghost_protocol'
      const focusId =
        state.selectedNodeId ??
        state.findings.at(-1)?.source_id ??
        state.nodes.find((n) => n.source_id !== 'vega-core')?.source_id ??
        'vega-core'
      const focusPos = positions.get(focusId)

      // Smooth camera target: zoom into selected node and shift left to leave room for Ghost Protocol drawer
      const targetZoom = isGhost ? 1.42 : state.zoomPercent / DEFAULT_ZOOM
      const targetX = isGhost && focusPos ? focusPos.x + 130 : 0
      const targetY = isGhost && focusPos ? focusPos.y : 0

      const lerp = 1 - Math.exp(-6 * dt)
      camera.x += (targetX - camera.x) * lerp
      camera.y += (targetY - camera.y) * lerp
      if (!drag || isGhost) {
        camera.zoom += (targetZoom - camera.zoom) * (reducedMotion.matches ? 1 : lerp)
      }
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
      if (!reducedMotion.matches) orbitSeconds.current += Math.max(0, dt)
      drawTopologyDots(ctx, size.width, size.height, origin, camera.zoom, hover, orbitSeconds.current)

      // Draw edges
      for (const edge of state.edges) {
        const p1 = positions.get(edge.from)
        const p2 = positions.get(edge.to)
        if (!p1 || !p2) continue
        const s1 = toScreen(p1.x, p1.y)
        const s2 = toScreen(p2.x, p2.y)

        const fromNode = state.nodes.find((n) => n.source_id === edge.from)
        const toNode = state.nodes.find((n) => n.source_id === edge.to)
        const isIsolated = fromNode?.status === 'isolated' || toNode?.status === 'isolated'
        const isPeerLink = edge.from !== 'vega-core' && edge.to !== 'vega-core'

        ctx.beginPath()
        ctx.moveTo(s1.sx, s1.sy)
        ctx.lineTo(s2.sx, s2.sy)

        if (isIsolated) {
          ctx.strokeStyle = isPeerLink ? 'rgba(248, 113, 113, 0.45)' : 'rgba(100, 116, 139, 0.24)'
          ctx.setLineDash([5, 5])
          ctx.lineWidth = isPeerLink ? 1.4 : 1
        } else if (edge.anomalous) {
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)'
          ctx.lineWidth = 2
        } else if (isPeerLink) {
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.52)'
          ctx.lineWidth = 1.6
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
        // Scale cards with their world positions when zooming out so they stay separated.
        // Keep the existing card size during the inspection camera's zoom-in.
        el.style.transform = `translate3d(${sx}px, ${sy}px, 0) translate(-50%, -50%) scale(${Math.min(1, camera.zoom)})`
        if (!el.style.visibility) el.style.visibility = 'visible'
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
  }, [size])

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
      inert={stage === 'blackout'}
      aria-label="Topology canvas"
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home - = 0"
      tabIndex={0}
      className="relative h-full w-full touch-none cursor-grab overflow-clip select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-300 data-[dragging=true]:cursor-grabbing"
    >
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

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
              className={`group invisible absolute top-0 left-0 flex items-center gap-2 border backdrop-blur-md ${ringClass} ${
                isCore
                  ? 'size-52 cursor-default flex-col justify-center overflow-hidden rounded-full px-5 text-center transition-[background-color,border-color,box-shadow] motion-reduce:transition-none'
                  : `rounded-xl px-2.5 py-1.5 text-left transition-colors ${stage === 'panopticon' ? 'cursor-grab data-[moving=true]:cursor-grabbing' : 'cursor-pointer'}`
              }`}
            >
              {isCore && (
                <>
                  <img
                    src={CORE_ARTWORK[eyeState]}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className={`vega-core-spin pointer-events-none absolute inset-0 size-full scale-105 rounded-full object-cover select-none ${wardenCore ? 'opacity-90' : 'opacity-65'}`}
                  />
                  {!wardenCore && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle,rgba(5,8,17,0.72)_0%,rgba(5,8,17,0.48)_58%,rgba(5,8,17,0.18)_100%)]"
                    />
                  )}
                </>
              )}

              {isCore ? (
                !wardenCore && (
                  <VegaEye
                    state={eyeState}
                    className="relative z-10 h-auto w-28 shrink-0 drop-shadow-[0_2px_8px_rgba(5,8,17,0.95)]"
                  />
                )
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

              <div className={`leading-tight ${isCore ? `${wardenCore ? 'absolute bottom-4' : 'relative'} z-10 drop-shadow-[0_1px_4px_rgba(5,8,17,0.95)]` : ''}`}>
                <div className={`flex items-center gap-1.5 ${isCore ? 'justify-center' : ''}`}>
                  <span
                    className={`text-slate-100 ${isCore ? 'font-display text-sm tracking-[0.06em] lowercase' : 'font-mono-tabular text-[11px] font-medium'}`}
                  >
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
                {!isCore && (
                  <div className="text-[10px] text-slate-400">
                    {isIsolated
                      ? dataMode === 'LIVE' && wardenDecision?.dry_run !== true
                        ? 'ISOLATED'
                        : 'ISOLATED (DRY-RUN)'
                      : node.role}
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

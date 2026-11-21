import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import { Lock, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MonitoredNode } from '../../contracts/vega'
import { particleBus } from '../../engine/particleBus'
import { useVegaStore } from '../../store/useVegaStore'

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
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = size.width * dpr
    canvas.height = size.height * dpr

    let rafId = 0
    let lastTime = performance.now()
    const camera = { x: 0, y: 0, zoom: 1 }

    const render = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000)
      lastTime = now

      const state = useVegaStore.getState()
      const isGhost = state.stage === 'ghost_protocol'
      const focusId = state.selectedNodeId ?? 'vm-a'
      const focusPos = basePositions.get(focusId)

      // Smooth camera target: zoom into selected node and shift left to leave room for Ghost Protocol drawer
      const targetZoom = isGhost ? 1.42 : 1
      const targetX = isGhost && focusPos ? focusPos.x + 130 : 0
      const targetY = isGhost && focusPos ? focusPos.y : 0

      const lerp = 1 - Math.exp(-6 * dt)
      camera.x += (targetX - camera.x) * lerp
      camera.y += (targetY - camera.y) * lerp
      camera.zoom += (targetZoom - camera.zoom) * lerp

      ctx.save()
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, size.width, size.height)

      const cx = size.width / 2
      const cy = size.height / 2

      const toScreen = (wx: number, wy: number) => ({
        sx: cx + (wx - camera.x) * camera.zoom,
        sy: cy + (wy - camera.y) * camera.zoom,
      })

      // Subtle orbital radar rings around vega-core
      const coreScreen = toScreen(0, 0)
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
        const p1 = basePositions.get(edge.from)
        const p2 = basePositions.get(edge.to)
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
        const pos = basePositions.get(node.source_id)
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
        const p1 = basePositions.get(p.from)
        const p2 = basePositions.get(p.to)
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
        const pos = basePositions.get(node.source_id)
        if (!el || !pos) continue
        const driftX = node.source_id === 'vega-core' ? 0 : Math.sin(now / 1800 + pos.x) * 2.5
        const driftY = node.source_id === 'vega-core' ? 0 : Math.cos(now / 2100 + pos.y) * 2.5
        const { sx, sy } = toScreen(pos.x + driftX, pos.y + driftY)
        el.style.transform = `translate3d(${sx}px, ${sy}px, 0) translate(-50%, -50%)`
      }

      rafId = window.requestAnimationFrame(render)
    }

    rafId = window.requestAnimationFrame(render)
    return () => window.cancelAnimationFrame(rafId)
  }, [basePositions, size])

  const handleNodeClick = (node: MonitoredNode) => {
    if (node.source_id === 'vega-core') return
    selectNode(node.source_id)
    if (stage === 'panopticon') {
      setStage('ghost_protocol')
    }
  }

  return (
    <div ref={containerRef} className="vega-grid-bg relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Top-left Panopticon Telemetry Legend */}
      <div className="pointer-events-none absolute top-4 left-4 z-10 flex flex-col gap-2">
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
            <span>CLICK ANY NODE TO INSPECT</span>
          </div>
        </div>
      </div>

      {/* Interactive HTML Node Badges synced to Canvas coordinates */}
      <div className="absolute inset-0 z-10">
        {nodes.map((node) => {
          const isCore = node.source_id === 'vega-core'
          const isSelected = selectedNodeId === node.source_id
          const isAlert = node.status === 'elevated' || node.status === 'compromised'
          const isIsolated = node.status === 'isolated'

          const ringClass = isCore
            ? 'border-sky-400/70 bg-sky-950/80 shadow-[0_0_30px_rgba(56,189,248,0.35)]'
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
              onClick={() => handleNodeClick(node)}
              className={`group absolute top-0 left-0 flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-left backdrop-blur-md transition-colors ${ringClass} ${
                isCore ? 'cursor-default px-3.5 py-2.5' : 'cursor-pointer'
              }`}
            >
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-black/40">
                {isIsolated ? (
                  <ShieldOff className="h-3.5 w-3.5 text-slate-400" />
                ) : isAlert ? (
                  <ShieldAlert className="h-3.5 w-3.5 text-red-400" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5 text-sky-400" />
                )}
              </div>

              <div className="leading-tight">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono-tabular text-[11px] font-semibold text-slate-100">
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
                <div className="text-[10px] text-slate-400">
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

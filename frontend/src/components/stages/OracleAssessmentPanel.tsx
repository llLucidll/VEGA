import { motion, useAnimate, useReducedMotion } from 'motion/react'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { OracleAssessment, Verdict as VerdictKind } from '../../contracts/vega'
import { useVegaStore } from '../../store/useVegaStore'

type Hypothesis = OracleAssessment['competing_explanations'][number]

const STATUS: Record<Hypothesis['status'], { label: string; tone: string }> = {
  ruled_out: { label: 'Ruled out', tone: 'text-slate-500' },
  unlikely: { label: 'Unlikely', tone: 'text-amber-300/70' },
  plausible: { label: 'Plausible', tone: 'text-emerald-300/70' },
}

const VERB: Record<VerdictKind, string> = { CONTAIN: 'Contain', NO_ACTION: 'Leave', ESCALATE: 'Escalate' }

// Timing (seconds). The verdict line appears first; sections start VERDICT_LEAD later.
// Per section: title appears, its first card follows TITLE_LEAD later. Each card takes RISE to
// reach its slot, rests face-down for PAUSE, takes FLIP to turn over, then its box DISSOLVEs.
// Cards within a section start STAGGER apart. The next section's title waits until the previous
// section's last card has finished flipping (or EMPTY_GAP after an empty section's title).
const VERDICT_LEAD = 0.45
const TITLE_LEAD = 0.12
const STAGGER = 0.2
const RISE = 0.32
const PAUSE = 0.2
const FLIP = 0.28
const DISSOLVE = 0.45
const EMPTY_GAP = 0.25
const EASE = [0.22, 1, 0.36, 1] as const

/** Start times for each section title and each card in it, given how many cards each section has. */
function schedule(cardsPerSection: number[], start: number) {
  let t = start
  return cardsPerSection.map((n) => {
    const title = t
    const cards = Array.from({ length: n }, (_, i) => title + TITLE_LEAD + i * STAGGER)
    const lastCard = cards.at(-1)
    t = lastCard === undefined ? title + EMPTY_GAP : lastCard + RISE + PAUSE + FLIP
    return { title, cards }
  })
}

// Readings already played this session (by incident + timestamp). The Council screen unmounts when
// you leave it, so this lives at module level: revisiting shows the cards face-up without replaying.
const playedReadings = new Set<string>()

// True when everything should appear in its final state with no animation.
const StillContext = createContext(false)

function useStill() {
  const reduceMotion = useReducedMotion()
  const alreadyPlayed = useContext(StillContext)
  return Boolean(reduceMotion) || alreadyPlayed
}

const skin = 'rounded-lg border border-slate-800 bg-slate-950/60'
const blank = 'rounded-lg border border-slate-800 bg-slate-900/70'
const label = 'font-mono-tabular text-[10px] tracking-[0.18em] text-slate-500 uppercase'
const hidden: CSSProperties = { backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }

/** Oracle's reading: the verdict first, then blank cards rise, turn face-up, and settle onto the panel. */
export function OracleAssessmentPanel() {
  const assessment = useVegaStore((s) => s.oracleAssessment)
  const signal = useVegaStore((s) => s.councilSignal)
  const id = assessment ? `${assessment.incident_id}-${assessment.created_at}` : ''

  return (
    <div data-oracle-panel className="vega-panel overflow-hidden rounded-2xl p-5 lg:col-span-7">
      <header className="flex items-baseline justify-between gap-3 border-b border-slate-800/80 pb-3">
        <span className="font-mono-tabular text-[11px] font-semibold tracking-wider text-purple-300/90 uppercase">
          Oracle Reading
        </span>
        {assessment && (
          <span className="truncate font-mono-tabular text-[10px] text-slate-500">
            {assessment.incident_id} • {assessment.model_version}
          </span>
        )}
      </header>

      {assessment ? (
        <PlayOnce key={id} id={id}>
          <Reading assessment={assessment} />
        </PlayOnce>
      ) : signal?.severity === 'SEV1' ? (
        <Deliberating />
      ) : (
        <p className="mt-4 text-xs text-slate-400">
          Oracle activates only after Sentinel confirms a SEV1 incident.
        </p>
      )}
    </div>
  )
}

/** Animates a reading the first time it is shown; afterwards renders it straight away. */
function PlayOnce({ id, children }: { id: string; children: ReactNode }) {
  const [alreadyPlayed] = useState(() => playedReadings.has(id))

  useEffect(() => {
    playedReadings.add(id)
  }, [id])

  return <StillContext.Provider value={alreadyPlayed}>{children}</StillContext.Provider>
}

function Reading({ assessment: a }: { assessment: OracleAssessment }) {
  const hypotheses = a.competing_explanations
  const policies = a.cited_policies

  // Sections in order: assessment (with scope), hypotheses, policies. The verdict line covers the action.
  const [s1, s2, s3] = schedule([1, hypotheses.length, policies.length], VERDICT_LEAD)

  return (
    <div className="mt-5">
      <VerdictLine assessment={a} />

      <div className="mt-6 space-y-5">
        <Section title="Assessment" delay={s1.title}>
          <TarotCard delay={s1.cards[0]}>
            <p className="text-xs leading-relaxed text-slate-300">{a.assessment}</p>
            <p className="mt-2.5 text-[11px] leading-relaxed text-slate-400">
              <span className="text-slate-500">Scope</span> <span className="mx-1 text-slate-700">·</span>
              {a.recommended_scope}
            </p>
          </TarotCard>
        </Section>

        <Section title="Hypotheses tested" meta={`${hypotheses.length} tested`} delay={s2.title}>
          {hypotheses.length ? (
            <div className="space-y-1">
              {hypotheses.map((h, i) => (
                <TarotCard key={h.hypothesis} delay={s2.cards[i]}>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-xs font-medium text-slate-200">{h.hypothesis}</span>
                    <span className={`shrink-0 text-[11px] ${STATUS[h.status].tone}`}>{STATUS[h.status].label}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{h.reason}</p>
                </TarotCard>
              ))}
            </div>
          ) : (
            <Note delay={s2.title}>No competing hypotheses recorded.</Note>
          )}
        </Section>

        <Section title="Policy review" meta={`${policies.length} cited`} delay={s3.title}>
          {policies.length ? (
            <div className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2">
              {policies.map((p, i) => (
                <TarotCard key={p.policy_id} delay={s3.cards[i]}>
                  <div className="font-mono-tabular text-[11px] text-slate-400">
                    {p.policy_id} <span className="text-slate-600">{p.version}</span>
                  </div>
                  <div className="mt-1 text-xs font-medium text-slate-200">{p.title}</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{p.excerpt}</p>
                </TarotCard>
              ))}
            </div>
          ) : (
            <Note delay={s3.title}>No policies cited.</Note>
          )}
        </Section>
      </div>
    </div>
  )
}

/** The answer, stated plainly and first: which hosts are contained, left alone, or escalated. */
function VerdictLine({ assessment: a }: { assessment: OracleAssessment }) {
  const still = useStill()
  const groups = (['CONTAIN', 'NO_ACTION', 'ESCALATE'] as const)
    .map((v) => ({ verdict: v, hosts: (a.verdicts ?? []).filter((x) => x.verdict === v).map((x) => x.source_id) }))
    .filter((g) => g.hosts.length)

  return (
    <motion.p
      initial={still ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="px-3 text-lg leading-snug text-slate-400"
    >
      {groups.length
        ? groups.map((g, i) => (
            <span key={g.verdict}>
              {i > 0 && <span className="mx-2.5 text-slate-700">·</span>}
              <span className="font-medium text-slate-50">{VERB[g.verdict]}</span> {g.hosts.join(', ')}
            </span>
          ))
        : <span className="text-slate-100">{a.recommended_action}</span>}
    </motion.p>
  )
}

function Section({ title, meta, delay, children }: { title: string; meta?: string; delay: number; children: ReactNode }) {
  const still = useStill()

  return (
    <section>
      <motion.div
        initial={still ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25, delay: still ? 0 : delay }}
        className="mb-1 flex items-baseline justify-between gap-3 px-3"
      >
        <h3 className={label}>{title}</h3>
        {meta && <span className="font-mono-tabular text-[10px] text-slate-600">{meta}</span>}
      </motion.div>
      {children}
    </section>
  )
}

/** Empty-section text, fading in with its title. */
function Note({ delay, children }: { delay: number; children: ReactNode }) {
  const still = useStill()

  return (
    <motion.p
      initial={still ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25, delay: still ? 0 : delay }}
      className="px-3 pt-2 text-[11px] text-slate-500"
    >
      {children}
    </motion.p>
  )
}

/**
 * Starts blank at the bottom edge of the Oracle panel, rises into its slot, turns face-up
 * bottom-over-top like a tarot card, then its box dissolves so the content settles onto the
 * panel under a hairline. Its height is set by the face, so nothing jumps on the flip.
 */
function TarotCard({ delay, children }: { delay: number; children: ReactNode }) {
  const still = useStill()
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const inner = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (still || !scope.current || !inner.current) return
    const card = scope.current
    const panel = card.closest('[data-oracle-panel]')
    const rise = panel ? panel.getBoundingClientRect().bottom - card.getBoundingClientRect().top : 32
    const settled = delay + RISE + PAUSE + FLIP

    animate(card, { y: [Math.max(rise, 32), 0], opacity: [0, 1] }, { duration: RISE, delay, ease: EASE })
    animate(inner.current, { rotateX: [180, 0] }, { duration: FLIP, delay: delay + RISE + PAUSE, ease: EASE })
    animate('[data-skin]', { opacity: 0 }, { duration: DISSOLVE, delay: settled + 0.1, ease: 'easeOut' })
    animate('[data-line]', { opacity: 1 }, { duration: DISSOLVE, delay: settled + 0.1, ease: 'easeOut' })
  }, [animate, delay, still, scope])

  if (still) {
    return (
      <div className="relative">
        <Hairline />
        <div className="relative p-3">{children}</div>
      </div>
    )
  }

  return (
    <div ref={scope} style={{ opacity: 0, perspective: 800 }}>
      <div ref={inner} className="grid" style={{ transformStyle: 'preserve-3d', transform: 'rotateX(180deg)' }}>
        <div className="relative [grid-area:1/1]" style={hidden}>
          <div data-skin className={`absolute inset-0 ${skin}`} />
          <Hairline animated />
          <div className="relative p-3">{children}</div>
        </div>
        <div aria-hidden className={`${blank} [grid-area:1/1]`} style={{ ...hidden, transform: 'rotateX(180deg)' }} />
      </div>
    </div>
  )
}

function Hairline({ animated = false }: { animated?: boolean }) {
  return (
    <div
      data-line={animated || undefined}
      className="absolute inset-x-3 top-0 h-px bg-slate-800"
      style={animated ? { opacity: 0 } : undefined}
    />
  )
}

/** A small stack of blank cards, the top one breathing softly, while the council deliberates. */
function Deliberating() {
  const reduceMotion = useReducedMotion()

  return (
    <div className="mt-6 flex flex-col items-center gap-3 pb-2">
      <div className="relative h-16 w-48">
        {[2, 1, 0].map((depth) => (
          <motion.div
            key={depth}
            className={`${blank} absolute inset-x-0 top-0 h-11`}
            style={{ y: depth * 6, scale: 1 - depth * 0.05, opacity: 1 - depth * 0.3 }}
            animate={reduceMotion || depth ? undefined : { opacity: [1, 0.55, 1] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          />
        ))}
      </div>
      <p className="text-[11px] text-slate-500">Deliberating…</p>
    </div>
  )
}

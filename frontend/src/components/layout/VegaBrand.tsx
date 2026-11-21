import { useId } from 'react'
import { useVegaEyeState } from '../../store/useVegaEyeState'

const STATUS_LABEL = {
  idle: 'Monitoring. No anomalies detected.',
  alert: 'Anomaly detected.',
  investigating: 'Council investigation in progress.',
} as const

const VEGA_PATHS = [
  'M1 0H15V44L26 37V0H39V45L2 66V2Z',
  'M47 0H78L85 4V11H71V9H60V20H76V29H60V44L71 37V35H85V45L48 66V2Z',
  'M93 0H124L131 4V11H117V9H107V37L117 43V33H112V24H131V66L94 45V2Z',
] as const

const VEGA_A_OUTER = 'M151 0H177V67L163 59V33H151V54L139 47V3Z'
const VEGA_A_INNER = 'M151 9V24H163V9Z'
const VEGA_A_EVENODD = `${VEGA_A_OUTER}${VEGA_A_INNER}`

export function VegaBrand({ onRecenter }: { onRecenter: () => void }) {
  const rawId = useId()
  const uid = rawId.replace(/:/g, '')

  const state = useVegaEyeState()
  if (state === 'warden') return null

  const isInvestigating = state === 'investigating'
  const accentColor = isInvestigating ? 'var(--vega-oracle)' : '#6ee7b7'
  const haloColor = isInvestigating ? 'var(--vega-oracle)' : '#34d399'

  const clipOuterId = `${uid}-clip-outer`
  const clipInnerId = `${uid}-clip-inner`
  const fillGradId = `${uid}-glass-fill`
  const rimGradId = `${uid}-glass-rim`
  const sheenGradId = `${uid}-glass-sheen`
  const haloFilterId = `${uid}-glass-halo`

  return (
    <>
      <span id="vega-eye-status" role="status" className="sr-only">
        {STATUS_LABEL[state]}
      </span>
      <button
        type="button"
        onClick={onRecenter}
        aria-label="VEGA — recenter topology"
        aria-describedby="vega-eye-status"
        title={`${STATUS_LABEL[state]} Click to recenter.`}
        className="vega-glass absolute top-4 left-1/2 z-30 inline-flex min-h-16 -translate-x-1/2 cursor-pointer items-center gap-3.5 rounded-full px-6 text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-300 sm:min-h-20 sm:px-7"
      >
        {/* Doom-inspired angular wordmark rendered as frosted liquid glass with specular rim & halo. */}
        <div aria-hidden="true" className="relative h-12 aspect-[182/72] shrink-0 sm:h-14">
          <div
            className="pointer-events-none absolute inset-0 backdrop-blur-md backdrop-saturate-150 backdrop-brightness-125"
            style={{ clipPath: `url(#${clipOuterId})` }}
          />
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="-2 -2 182 72"
            className="relative block h-full w-full overflow-visible"
          >
            <defs>
              <clipPath id={clipOuterId} clipPathUnits="objectBoundingBox">
                <g transform="scale(0.00549451, 0.01388889) translate(2, 2)">
                  {VEGA_PATHS.map((d) => (
                    <path key={d} d={d} />
                  ))}
                  <path clipRule="evenodd" d={VEGA_A_EVENODD} />
                </g>
              </clipPath>
              <clipPath id={clipInnerId}>
                {VEGA_PATHS.map((d) => (
                  <path key={d} d={d} />
                ))}
                <path clipRule="evenodd" d={VEGA_A_EVENODD} />
              </clipPath>
              <linearGradient id={fillGradId} x1="0" y1="0" x2="0.2" y2="1">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.38" />
                <stop offset="45%" stopColor="#e2e8f0" stopOpacity="0.10" />
                <stop offset="100%" stopColor={accentColor} stopOpacity="0.24" />
              </linearGradient>
              <linearGradient id={rimGradId} x1="0" y1="0" x2="0.8" y2="1">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
                <stop offset="45%" stopColor="#e2e8f0" stopOpacity="0.28" />
                <stop offset="100%" stopColor={accentColor} stopOpacity="0.85" />
              </linearGradient>
              <linearGradient id={sheenGradId} x1="0" y1="0" x2="0.3" y2="1">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </linearGradient>
              <filter id={haloFilterId} x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3.2" result="blur" />
                <feFlood floodColor={haloColor} floodOpacity="0.45" result="glowColor" />
                <feComposite in="glowColor" in2="blur" operator="in" result="softGlow" />
                <feMerge>
                  <feMergeNode in="softGlow" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <g filter={`url(#${haloFilterId})`}>
              <g fill={`url(#${fillGradId})`}>
                {VEGA_PATHS.map((d) => (
                  <path key={d} d={d} />
                ))}
                <path fillRule="evenodd" d={VEGA_A_EVENODD} />
              </g>
              <g clipPath={`url(#${clipInnerId})`}>
                <path d="M-10 -5 H190 V26 Q90 38 -10 22 Z" fill={`url(#${sheenGradId})`} />
              </g>
              <g fill="none" stroke={`url(#${rimGradId})`} strokeWidth="1.6" strokeLinejoin="miter">
                {VEGA_PATHS.map((d) => (
                  <path key={d} d={d} />
                ))}
                <path d={VEGA_A_OUTER} />
                <path d={VEGA_A_INNER} />
              </g>
            </g>
          </svg>
        </div>
      </button>
    </>
  )
}

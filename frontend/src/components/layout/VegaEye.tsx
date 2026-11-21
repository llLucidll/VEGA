import { motion, useReducedMotion } from 'motion/react'
import { useId } from 'react'
import type { VegaEyeState } from '../../store/useVegaEyeState'

const OPEN_EYE = 'M18 0C10.8 0 4.1 6.1.5 10.6a2.2 2.2 0 0 0 0 2.8C4.1 17.9 10.8 24 18 24s13.9-6.1 17.5-10.6a2.2 2.2 0 0 0 0-2.8C31.9 6.1 25.2 0 18 0Z'

// The two sides of the closed aperture meet along the lash line. Matching
// commands let Motion separate the lids and reveal the pupil in one movement.
const CLOSED_APERTURE = 'M2 5C6 11 11.5 15 18 15C24.5 15 30 11 34 5C30 11 24.5 15 18 15C11.5 15 6 11 2 5Z'
const OPEN_APERTURE = 'M-2 12C3 5 9 -2 18 -2C27 -2 33 5 38 12C33 19 27 26 18 26C9 26 3 19 -2 12Z'

export function VegaEye({ state, className }: { state: VegaEyeState; className?: string }) {
  const apertureId = useId()
  const reduceMotion = useReducedMotion()
  const closed = state === 'idle'

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-eye-state={state}
      viewBox="0 0 36 24"
      fill="currentColor"
      className={className}
    >
      {state === 'warden' ? (
        <>
          <path
            d="M2 12C7.5 6 13 3 18 3s10.5 3 16 9c-5.5 6-11 9-16 9S7.5 18 2 12Z"
            fill="currentColor"
            fillOpacity=".16"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <path d="M18 4.5c3.5 4 3.5 11 0 15-3.5-4-3.5-11 0-15Z" />
        </>
      ) : (
        <>
          <defs>
            <clipPath id={apertureId}>
              <motion.path
                initial={false}
                animate={{ d: closed ? CLOSED_APERTURE : OPEN_APERTURE }}
                transition={{ duration: reduceMotion ? 0 : closed ? 0.24 : 0.5, ease: 'easeOut' }}
              />
            </clipPath>
          </defs>
          <g clipPath={`url(#${apertureId})`}>
            <path
              fillRule="evenodd"
              d={`${OPEN_EYE}M18 4.8a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4Z`}
            />
            <circle
              cx="18"
              cy="12"
              r="3.3"
              className={closed ? undefined : 'vega-eye-scan'}
            />
          </g>
          <motion.path
            d="M2 5C6 11 11.5 15 18 15S30 11 34 5M7.5 11.5 3 16m10.5-1.5-2 6.5m11-6.5 2 6.5m4-9.5 4.5 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={false}
            animate={{ opacity: closed ? 1 : 0 }}
            transition={{ duration: reduceMotion ? 0 : closed ? 0.14 : 0.28 }}
          />
        </>
      )}
    </svg>
  )
}

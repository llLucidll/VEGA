export function VegaCoreMark({
  className = 'size-4.5',
  label,
}: {
  className?: string
  label?: string
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      className={`vega-core-spin ${className}`}
    >
      {/* Outer segmented orbital ring */}
      <circle
        cx="50"
        cy="50"
        r="44"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeDasharray="28 8 14 6 34 10"
        opacity="0.72"
      />
      <path
        d="M 81.5 14.5 A 47.5 47.5 0 0 1 95.5 36.5"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.88"
      />

      {/* Three VEGA Core reactor lobes + inner pills */}
      {[0, 120, 240].map((deg) => (
        <g key={deg} transform={`rotate(${deg} 50 50)`}>
          <path
            d="M 58 20.1 A 31 31 0 0 1 79.9 58"
            stroke="currentColor"
            strokeWidth="10.5"
            strokeLinecap="round"
          />
          <path
            d="M 48.5 28.6 A 21.5 21.5 0 0 1 57.2 29.7"
            stroke="currentColor"
            strokeWidth="5.2"
            strokeLinecap="round"
            opacity="0.92"
          />
        </g>
      ))}

      {/* Inner containment ring + core */}
      <circle
        cx="50"
        cy="50"
        r="16"
        stroke="currentColor"
        strokeWidth="2.4"
        opacity="0.78"
      />
      <circle cx="50" cy="50" r="10.5" fill="currentColor" />
    </svg>
  )
}

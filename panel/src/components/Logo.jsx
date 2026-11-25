// Claude "sunburst" logo (inline SVG, no dependencies). Signature orange.
export default function Logo({ size = 30, className = '' }) {
  const rays = Array.from({ length: 12 })
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      role="img"
      aria-label="Claude"
    >
      {rays.map((_, i) => (
        <rect
          key={i}
          x="46.5"
          y="6"
          width="7"
          height="38"
          rx="3.5"
          fill="#D97757"
          transform={`rotate(${i * 30} 50 50)`}
        />
      ))}
    </svg>
  )
}

/** Tiny area sparkline for a 0-100 series: whisper of fill, endpoint emphasised. */
export function Sparkline({
  values,
  className = "",
}: {
  values: number[];
  className?: string;
}) {
  const h = 32;
  const step = 100 / Math.max(values.length - 1, 1);
  const y = (v: number) => h - 2 - (v / 100) * (h - 4);
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`);
  const last = values.at(-1) ?? 0;

  return (
    <div
      className={`relative h-8 ${className}`}
      role="img"
      aria-label={`Trend, now ${Math.round(last)} percent`}
    >
      <svg
        viewBox={`0 0 100 ${h}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible text-accent"
        aria-hidden="true"
      >
        <polygon
          points={`0,${h} ${points.join(" ")} 100,${h}`}
          fill="currentColor"
          opacity="0.12"
        />
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
      </svg>
      <span
        aria-hidden="true"
        className="absolute right-0 size-1.5 translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-panel"
        style={{ top: `${(y(last) / h) * 100}%` }}
      />
    </div>
  );
}

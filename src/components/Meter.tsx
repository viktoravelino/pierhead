/** Tide-gauge style meter: a fill bar over a ruler of ticks every 10%. */
export function Meter({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const fill = clamped >= 90 ? "bg-crit" : clamped >= 75 ? "bg-warn" : "bg-accent";
  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> cannot be styled as a tick-ruler gauge
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className="flex flex-col gap-1"
    >
      <div className="h-2 overflow-hidden rounded-[2px] bg-sunken">
        <div className={`h-full ${fill}`} style={{ width: `${clamped}%` }} />
      </div>
      <div
        aria-hidden="true"
        className="h-1 text-line-strong"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to right, currentColor 0 1px, transparent 1px 10%)",
          backgroundSize: "calc(100% + 1px) 100%",
        }}
      />
    </div>
  );
}

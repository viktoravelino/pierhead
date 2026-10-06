const units = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
] as const;

/** Compact relative time: "just now", "12m ago", "3h ago", "6d ago". */
export function relativeTime(iso: string, now = Date.now()) {
  const diff = now - new Date(iso).getTime();
  for (const [suffix, ms] of units) {
    if (diff >= ms) return `${Math.floor(diff / ms)}${suffix} ago`;
  }
  return "just now";
}

/** "in 3h" style for future timestamps. */
export function untilTime(iso: string, now = Date.now()) {
  const diff = new Date(iso).getTime() - now;
  for (const [suffix, ms] of units) {
    if (diff >= ms) return `in ${Math.floor(diff / ms)}${suffix}`;
  }
  return "soon";
}

export const formatDuration = (s: number) =>
  s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;

export const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour12: false });

/** "4d 20h", "3h 12m", "5m": uptime from seconds, two units at most. */
export function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

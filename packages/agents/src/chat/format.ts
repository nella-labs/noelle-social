/**
 * Tiny formatting helpers for chat profiles. Pure functions; no Date
 * dependency injection because every callsite uses the wall clock at the
 * moment the system prompt is built. Tests can pass `now` explicitly.
 */

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * "5m ago" / "2h ago" / "3d ago". Returns "just now" for sub-minute
 * deltas and "never" for null/invalid input. Future timestamps clamp
 * to "just now" rather than producing nonsense like "-3m ago".
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const deltaMs = now.getTime() - t;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

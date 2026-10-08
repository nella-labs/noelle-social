export type BrowserPlatform = "linkedin" | "x";

// Keep X's existing 40/day default and explicit unlimited sentinel. The
// per-instance operator override below takes precedence when one is saved.
export function resolveDailyWriteCap(raw: string | undefined | null, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  if (typeof raw === "string" && /^(off|unlimited)$/i.test(raw.trim())) return Number.POSITIVE_INFINITY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveXDailyWriteCap(raw: string | undefined | null): number {
  return resolveDailyWriteCap(raw, 40);
}

export function resolveBrowserReplyCap(platform: BrowserPlatform, override: number | null | undefined): number | null {
  if (typeof override === "number" && Number.isInteger(override) && override >= 0 && override <= 500) return override;
  if (platform === "linkedin") return null; // existing reply lane has no default reply-only cap
  const cap = resolveXDailyWriteCap(process.env.NOELLE_X_ACTUATOR_DAILY_WRITE_CAP);
  return Number.isFinite(cap) ? cap : null;
}

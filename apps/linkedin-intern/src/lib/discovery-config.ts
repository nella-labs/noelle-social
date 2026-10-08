import { DiscoveryConfigSchema, type DiscoveryConfig } from "@noelle/contracts";

/**
 * The discovery tuning that actually applies to Lyra's per-connection sweep. The
 * shared DiscoveryConfig (0032) carries X-only search-operator fields too
 * (minFaves/lang/...); LinkedIn honours only the platform-applicable subset:
 *   - postsPerSource  → maxPosts per connection per tick (Apify call size)
 *   - timeWindowHours → only ingest posts newer than N hours (post.postedAt)
 *   - minReactions    → drop posts below this reaction count (post.reactions)
 *   - minComments     → drop posts below this comment count (post.comments)
 */
export interface LinkedinDiscoveryFilters {
  postsPerSource: number;
  timeWindowHours: number | null;
  minReactions: number | null;
  minComments: number | null;
}

// Parse a raw jsonb column into a (partial) DiscoveryConfig. Junk degrades to {}
// rather than throwing — discovery must never crash on a bad config blob.
function parseLayer(raw: unknown): DiscoveryConfig {
  if (raw == null || typeof raw !== "object") return {};
  const res = DiscoveryConfigSchema.safeParse(raw);
  return res.success ? res.data : {};
}

// First layer that *defines* a key (present, value !== undefined). null is
// meaningful — run_config { timeWindowHours: null } turns OFF a window the saved
// default set, so it must win over the default.
function pick<T>(key: keyof DiscoveryConfig, layers: DiscoveryConfig[]): T | undefined {
  for (const layer of layers) {
    const v = (layer as Record<string, unknown>)[key];
    if (v !== undefined) return v as T;
  }
  return undefined;
}

/**
 * Resolve Lyra's discovery filters: the active run override (`run_config`) wins
 * field-by-field over the saved default (`discovery_config`). postsPerSource
 * falls back to the worker's env default (LINKEDIN_DISCOVERY_LIMIT) when neither
 * layer sets it, so an un-tailored instance keeps its historical fetch size.
 */
export function resolveLinkedinDiscovery(
  inst: { discovery_config?: unknown; run_config?: unknown },
  opts: { defaultPostsPerSource: number },
): LinkedinDiscoveryFilters {
  const def = parseLayer(inst.discovery_config);
  const run = parseLayer(inst.run_config);
  const layers = [run, def];
  const pps = pick<number>("postsPerSource", layers);
  return {
    postsPerSource: pps ?? opts.defaultPostsPerSource,
    timeWindowHours: pick<number | null>("timeWindowHours", layers) ?? null,
    minReactions: pick<number | null>("minReactions", layers) ?? null,
    minComments: pick<number | null>("minComments", layers) ?? null,
  };
}

/** ISO lower bound for a time window, or null when no window is set. */
export function windowSinceISO(now: Date, hours: number | null): string | null {
  if (hours == null) return null;
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

/** The later of two ISO bounds (lexicographic on ISO == chronological). null-safe. */
export function laterISO(a: string, b: string | null): string {
  return b != null && b > a ? b : a;
}

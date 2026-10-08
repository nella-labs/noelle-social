import { DiscoveryConfigSchema, type DiscoveryConfig } from "@noelle/contracts";

/**
 * The discovery tuning that actually applies to Orion's per-subreddit sweep. The
 * shared DiscoveryConfig (0032) carries X/LinkedIn-only fields too; Reddit honours
 * only the platform-applicable subset:
 *   - postsPerSource  → maxItems per subreddit per tick (Apify call size)
 *   - timeWindowHours → only ingest posts newer than N hours (post.createdAt)
 *
 * The per-post SCORE floor is per-subreddit (noelle.reddit_watchlist.min_score),
 * not a discovery-config field, so it isn't resolved here.
 */
export interface RedditDiscoveryFilters {
  postsPerSource: number;
  timeWindowHours: number | null;
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
 * Resolve Orion's discovery filters: the active run override (`run_config`) wins
 * field-by-field over the saved default (`discovery_config`). postsPerSource
 * falls back to the worker's env default (REDDIT_DISCOVERY_LIMIT) when neither
 * layer sets it, so an un-tailored instance keeps its historical fetch size.
 */
export function resolveRedditDiscovery(
  inst: { discovery_config?: unknown; run_config?: unknown },
  opts: { defaultPostsPerSource: number },
): RedditDiscoveryFilters {
  const def = parseLayer(inst.discovery_config);
  const run = parseLayer(inst.run_config);
  const layers = [run, def];
  const pps = pick<number>("postsPerSource", layers);
  return {
    postsPerSource: pps ?? opts.defaultPostsPerSource,
    timeWindowHours: pick<number | null>("timeWindowHours", layers) ?? null,
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

import {
  DiscoveryConfigSchema,
  DEFAULT_DISCOVERY_CONFIG,
  type DiscoveryConfig,
  type ResolvedDiscoveryConfig,
} from "@noelle/contracts";
import type { ActiveInstance } from "./activation.js";

export type { ResolvedDiscoveryConfig };

// Parse a raw jsonb column into a (partial) DiscoveryConfig. Anything that
// doesn't validate (legacy junk, a hand-edited row) degrades to {} rather than
// throwing — discovery must never crash on a bad config blob.
function parseLayer(raw: unknown): DiscoveryConfig {
  if (raw == null || typeof raw !== "object") return {};
  const res = DiscoveryConfigSchema.safeParse(raw);
  return res.success ? res.data : {};
}

// Pick the first layer that *defines* a key (key present, value !== undefined).
// null is a meaningful value — e.g. run_config { timeWindowHours: null } turns
// OFF a window the default had set, so it must win over the default.
function pick<K extends keyof ResolvedDiscoveryConfig>(
  key: K,
  ...layers: DiscoveryConfig[]
): ResolvedDiscoveryConfig[K] {
  for (const layer of layers) {
    const v = (layer as Record<string, unknown>)[key];
    if (v !== undefined) return v as ResolvedDiscoveryConfig[K];
  }
  return DEFAULT_DISCOVERY_CONFIG[key];
}

/**
 * Resolve the discovery config for a tick: the active run override
 * (`run_config`) wins field-by-field over the saved default (`discovery_config`),
 * which wins over the worker defaults (DEFAULT_DISCOVERY_CONFIG).
 */
export function resolveDiscoveryConfig(inst: ActiveInstance): ResolvedDiscoveryConfig {
  const def = parseLayer(inst.discovery_config);
  const run = parseLayer(inst.run_config);
  return {
    timeWindowHours: pick("timeWindowHours", run, def),
    postsPerSource: pick("postsPerSource", run, def),
    minFaves: pick("minFaves", run, def),
    minReplies: pick("minReplies", run, def),
    excludeRetweets: pick("excludeRetweets", run, def),
    excludeReplies: pick("excludeReplies", run, def),
    lang: pick("lang", run, def),
    // LinkedIn-only fields — resolved for type-completeness; the X sweep ignores them.
    minReactions: pick("minReactions", run, def),
    minComments: pick("minComments", run, def),
  };
}

/**
 * The later of two ISO bounds (lexicographic on ISO == chronological). null-safe.
 * Used to narrow a watch-lane fetch to `max(window, person.added_at)`: posts from
 * before someone was added are discarded client-side anyway (their history
 * belongs to the profiler, not the reply pipeline), and Apify bills per ITEM, so
 * fetching them is money spent on rows that are guaranteed to be dropped.
 */
export function laterISO(a: string, b: string | null | undefined | Date): string {
  // Coerce BOTH sides to ISO strings before comparing. postgres.js returns a
  // timestamptz column as a JS Date, and `Date > "2026-05-29T…"` is an abstract
  // relational comparison: not both strings, so both go through Number(), and
  // Number(isoString) is NaN — every comparison silently false, so the narrowing
  // became a no-op that no type error could catch (the caller's row type
  // declared `string` while the driver handed back a Date).
  if (b == null) return a;
  const bs = b instanceof Date ? b.toISOString() : String(b);
  return bs > a ? bs : a;
}

/** ISO lower-bound for a time window, or undefined when no window is set. */
export function sinceFromWindow(now: Date, hours: number | null): string | undefined {
  if (hours == null) return undefined;
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

/**
 * Augment a keyword with X's native search operators from the config. Time
 * window + engagement floors + post-type filters are evaluated server-side by
 * X (the handle-poll path can't do engagement/type filtering — no per-tweet
 * counts on that payload), so they ride the query string here.
 *
 *   buildSearchQuery("ai agents", { minFaves: 50, excludeRetweets: true, ... })
 *     => "ai agents min_faves:50 -filter:nativeretweets"
 */
export function buildSearchQuery(
  keyword: string,
  config: ResolvedDiscoveryConfig,
  now: Date,
): string {
  const parts = [keyword.trim()];
  if (config.minFaves != null && config.minFaves > 0) parts.push(`min_faves:${config.minFaves}`);
  if (config.minReplies != null && config.minReplies > 0) parts.push(`min_replies:${config.minReplies}`);
  if (config.excludeRetweets) parts.push("-filter:nativeretweets");
  if (config.excludeReplies) parts.push("-filter:replies");
  if (config.lang) parts.push(`lang:${config.lang}`);
  if (config.timeWindowHours != null) {
    // since_time: unix seconds — hour-granular, narrows X server-side so the
    // post limit isn't spent on stuff the client-side window would drop.
    const sinceSec = Math.floor((now.getTime() - config.timeWindowHours * 3_600_000) / 1000);
    parts.push(`since_time:${sinceSec}`);
  }
  return parts.join(" ");
}

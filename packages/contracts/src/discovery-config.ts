import { z } from "zod";

// Tailored-discovery config (0032_discovery_config.sql). The same shape is the
// saved DEFAULT (agent_instances.discovery_config) and the per-run OVERRIDE
// (agent_instances.run_config). All keys optional so a partial override merges
// field-by-field over the default; an absent/empty object means "worker
// defaults" (see DEFAULT_DISCOVERY_CONFIG).
//
// Applicability:
//   - timeWindowHours, postsPerSource → BOTH agents. X (apps/x-intern): handle
//     polling AND keyword search. LinkedIn (apps/linkedin-intern discovery-tick):
//     the per-connection post sweep (post.postedAt window + posts-per-connection cap).
//   - minFaves, minReplies, excludeRetweets, excludeReplies, lang → X keyword
//     search only (they ride X's native search operators; per-tweet engagement
//     isn't on the handle-poll payload).
//   - minReactions, minComments → LinkedIn only (the per-connection sweep filters
//     client-side on the engagement Apify already attaches: post.reactions /
//     post.comments). The LinkedIn analogue of minFaves/minReplies.
export const DiscoveryConfigSchema = z
  .object({
    /** Only ingest posts newer than N hours. null = no window. Both agents. */
    timeWindowHours: z.number().int().min(1).max(168).nullable().optional(),
    /** Posts pulled per source (X handle/keyword, LinkedIn connection) per tick. */
    postsPerSource: z.number().int().min(5).max(100).optional(),
    /** X keyword search: min likes (X `min_faves:`). null = no floor. */
    minFaves: z.number().int().min(0).max(1_000_000).nullable().optional(),
    /** X keyword search: min replies (X `min_replies:`). null = no floor. */
    minReplies: z.number().int().min(0).max(1_000_000).nullable().optional(),
    /** X keyword search: drop native retweets (`-filter:nativeretweets`). */
    excludeRetweets: z.boolean().optional(),
    /**
     * Drop REPLIES so the agent answers ORIGINAL posts, not comments buried
     * under a post. Enforced two ways: X's `-filter:replies` operator on the
     * keyword lane (server-side) AND a client-side `is_reply` skip on BOTH lanes
     * (the watchlist/handle lane has no server operator). Defaults ON.
     */
    excludeReplies: z.boolean().optional(),
    /** X keyword search: restrict language (X `lang:`), e.g. "en". null = any. */
    lang: z
      .string()
      .regex(/^[a-z]{2}$/, "two-letter ISO language code")
      .nullable()
      .optional(),
    /** LinkedIn sweep: min reactions on the source post. null = no floor. */
    minReactions: z.number().int().min(0).max(1_000_000).nullable().optional(),
    /** LinkedIn sweep: min comments on the source post. null = no floor. */
    minComments: z.number().int().min(0).max(1_000_000).nullable().optional(),
  })
  .strict();

export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

// Fully-resolved config a discovery tick acts on — every field concrete (no
// undefined). postsPerSource is always a number; the rest are nullable where
// null means "no filter".
export interface ResolvedDiscoveryConfig {
  timeWindowHours: number | null;
  postsPerSource: number;
  minFaves: number | null;
  minReplies: number | null;
  excludeRetweets: boolean;
  excludeReplies: boolean;
  lang: string | null;
  minReactions: number | null;
  minComments: number | null;
}

// Resolved defaults — what a tick uses when neither the saved default nor the
// run override sets a field. postsPerSource: 20 matches the historical
// hardcoded discovery limit, so an empty config reproduces prior behaviour.
export const DEFAULT_DISCOVERY_CONFIG: ResolvedDiscoveryConfig = {
  timeWindowHours: null,
  postsPerSource: 20,
  // Engagement floor: only posts with at least this many likes become leads.
  // 50 keeps the agent on *performing* posts and off low-signal noise (throwaway
  // replies, 2-like one-liners). Enforced both server-side (X `min_faves:` on the
  // keyword query) and client-side (a hard guard in the discovery tick that covers
  // both lanes). Operators can lower/raise or null it per-instance in run_config.
  minFaves: 50,
  minReplies: null,
  excludeRetweets: false,
  // ON by default: the agent should reply to original posts, not to replies
  // sitting under a post. Operators can flip it off per-instance in run_config.
  excludeReplies: true,
  lang: null,
  minReactions: null,
  minComments: null,
};

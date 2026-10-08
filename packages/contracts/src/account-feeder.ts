import { z } from "zod";

// Account Feeder contracts (0051_account_feeder.sql). The Account Feeder pulls
// posts + comments from admired source accounts, distils each account's writing
// style into an "ultra profile", and stores a "style corpus" the drafter samples
// to imitate real human style per-lead.
//
// Two shapes live here:
//   - AccountFeederConfigSchema — the jsonb stored in
//     agent_instances.account_feeder_config. A NULL column means the feeder is
//     OFF; a present (even empty) object turns it ON and supplies tuning knobs.
//   - AccountFeederSourceSchema — one curated source account (a row of
//     noelle.account_feeder_sources).
//
// Run-trigger request/response schemas are intentionally DEFERRED: the manual
// "pull now" is a direct-SQL dashboard flag flip
// (agent_instances.account_feeder_run_requested_at), so v1 needs no JWT
// api-vm route/contract. Revisit if a self-serve HTTP trigger is added.

// Stored in agent_instances.account_feeder_config (NULL column = feeder OFF).
// Every field has a sensible default so an empty object reproduces the default
// behaviour and only set keys override it.
export const AccountFeederConfigSchema = z
  .object({
    /**
     * How many style exemplars to inject per lead. Default 1 (a single
     * best-fit exemplar): injecting more over-weights the source accounts'
     * voice so the reply reads like a blend of them rather than the operator —
     * the "looks AI again" tell. Raise per-instance via account_feeder_config
     * when a heavier style transfer is wanted; 0 = exemplars off.
     */
    maxStyleExemplars: z.number().int().min(0).max(20).default(1),
    /**
     * Variety knob for the per-lead style sample. 0 = always the single
     * best-fit style exemplar; 1 = maximum variety in the
     * performance-weighted sample.
     */
    varietyTemperature: z.number().min(0).max(1).default(0.4),
    /**
     * Engagement floor: only corpus items at/above this performance percentile
     * (0-100) are eligible as exemplars. 0 = no floor.
     */
    minPerformancePercentile: z.number().min(0).max(100).default(0),
    /**
     * Tiered batching: group light / low-value leads into multi-lead style
     * calls to save cost.
     */
    batchLightLeads: z.boolean().default(true),
    /**
     * WHICH KINDS of a source account's corpus shape the drafter's FORM. Each
     * account is pulled as `kind='post'` (their original posts) and
     * `kind='comment'` (replies they authored on other people's posts). Original
     * posts are a person's considered, high-signal voice; their comments are
     * often sloppy throwaways. So the default is POSTS ONLY (`['post']`) — the
     * reply drafter grounds its STYLE block in the source's original posts and
     * ignores their comments. Set `['post','comment']` to fold their comments
     * back in (the older "pool both" behaviour), or `['comment']` for
     * comments-only. Applies on the drafter's next tick (no restart). An empty
     * array is rejected; omitted = posts only.
     */
    styleExemplarKinds: z
      .array(z.enum(["post", "comment"]))
      .min(1)
      .default(["post"]),
    /**
     * PINNED STYLE SOURCE (the "write in this exact person's style" lever). When
     * set to a source account's canonical handle (a noelle.account_feeder_sources
     * row for this instance), the drafter stops auto-blending the whole enabled
     * pool and instead grounds its STYLE block ONLY in that one account's real
     * posts + ultra profile — "exact" mode. An explicit pin OVERRIDES the source's
     * enabled flag (the operator is asking for it by name) and turns style
     * injection on even when the NOELLE_*_STYLE env gate is off. Empty / omitted =
     * today's automatic behaviour (blend across enabled sources, gated by env).
     * Set from the drafter panel's style picker or resolved from the drafter chat
     * ("follow Kaia's style"). Only the operator's own vault voice grounds the
     * CONTENT; the pin only fixes the FORM.
     */
    pinnedStyleHandle: z.string().trim().min(1).optional(),
    /**
     * Explicit list of source-account handles to write REPLIES faithfully in, ONE
     * per reply, rotating deterministically across the feed so each reply sounds
     * like a single real writer and the feed alternates between them. When set,
     * this drives faithful-voice mode and OVERRIDES pinnedStyleHandle (which is the
     * single-voice form of the same idea). Handles are matched enabled-independently,
     * like a pin.
     */
    faithfulVoices: z.array(z.string().trim().min(1)).min(1).optional(),
    /**
     * Optional per-voice selection weights, parallel to faithfulVoices. When
     * present AND the same length, the per-lead voice draw is weighted by these
     * proportions instead of uniform — e.g. faithfulVoices ["kaia","henry"] with
     * [0.6, 0.4] writes ~60% of replies in kaia's voice, 40% in henry's, still one
     * faithful writer per reply (never a blend). Values are relative; they need
     * not sum to 1. Ignored (uniform draw) when absent or length-mismatched.
     */
    faithfulVoiceWeights: z.array(z.number().min(0)).optional(),
  })
  .strict();

export type AccountFeederConfig = z.infer<typeof AccountFeederConfigSchema>;

// One curated source account to learn style from (a noelle.account_feeder_sources
// row, handle-keyed). `handle` is trimmed/normalised so the (instance, platform,
// handle) unique key stays stable.
export const AccountFeederSourceSchema = z
  .object({
    /** Account handle / vanity slug. Trimmed + lowercased for a stable key. */
    handle: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "handle is required"),
    /** Platform the account lives on. */
    platform: z.enum(["linkedin", "x"]).default("linkedin"),
    /** Optional human-friendly name for the dashboard. */
    displayName: z.string().trim().optional(),
    /** Optional operator note ("why we admire this account"). */
    note: z.string().trim().optional(),
    /** Whether this source is pulled on the next feeder run. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type AccountFeederSource = z.infer<typeof AccountFeederSourceSchema>;

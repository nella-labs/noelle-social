import type { SpendRow } from "./spendRecorder.js";
import type { AgentRole } from "./types.js";

// Apify HarvestAPI bills per RESULT extracted, not per token. These are the
// per-1,000-result prices in whole cents, taken from the account's actual
// pricing tier in the Apify console (2026-06): all three actors bill $2/1k.
// Keyed by the bare actor name (the slug after "harvestapi/").
export const APIFY_PRICES_CENTS_PER_1K: Record<string, number> = {
  "linkedin-profile-posts": 200, //    $2.00 / 1k posts
  "linkedin-post-search": 200, //      $2.00 / 1k posts
  "linkedin-post-comments": 200, //    $2.00 / 1k comments
  "linkedin-profile-comments": 200, // $2.00 / 1k comments (Account Feeder authored-comments corpus)
  "reddit-posts-scraper": 300, //      $3.00 / 1k posts (parseforge/reddit-posts-scraper)
  // kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest (X discovery
  // reads — migrated off apidojo/twitter-scraper-lite on 2026-06-23, which started
  // returning demo-only data to FREE-plan tokens). Pay-per-result; ~$0.25/1k is the
  // actor's advertised "cheapest" rate — a conservative ESTIMATE for the dashboard.
  "twitter-x-data-tweet-scraper": 25, // ~$0.25 / 1k tweets (estimate)
  // kaitoeasyapi/premium-x-follower-scraper-following-data — X PERSON discovery
  // (followers/followings of a seed account, each carrying a bio). Same publisher
  // as the tweet actor above, chosen because it is the one proven to return real
  // data on FREE-plan tokens. Advertised ~$0.15/1k users.
  "premium-x-follower-scraper": 15, // ~$0.15 / 1k users (estimate)
  // Retained so historical apidojo spend rows still price correctly.
  "twitter-scraper-lite": 40, //         ~$0.40 / 1k tweets (legacy estimate)
  // Nova video harvest (read-only). apify/instagram-scraper + clockworks/tiktok-scraper
  // bill per result; conservative estimates for the dashboard until tuned to the tier.
  "instagram-scraper": 230, //           ~$2.30 / 1k results (estimate)
  "tiktok-scraper": 400, //              ~$4.00 / 1k results (estimate)
};

/** Conservative fallback (most expensive listed actor) for an unlisted actor. */
export const DEFAULT_APIFY_CENTS_PER_1K = 200;

/**
 * FALLBACK ONLY. Estimate the cost in whole cents of one Apify actor run that
 * returned `resultCount` items, from the hardcoded price table above. Used only
 * when Apify's real per-run figure (`usageTotalUsd`, see {@link apifySpendRow}'s
 * `actualUsd`) is unavailable — e.g. a run object that came back without usage, or
 * historical callers that never captured it. Rounds up to at least 1 cent for any
 * non-empty run (a run that returned nothing is free), mirroring estimateCallCents.
 */
export function estimateApifyCents(actor: string, resultCount: number): number {
  if (!Number.isFinite(resultCount) || resultCount <= 0) return 0;
  const per1k = APIFY_PRICES_CENTS_PER_1K[actor] ?? DEFAULT_APIFY_CENTS_PER_1K;
  return Math.max(1, Math.ceil((resultCount * per1k) / 1000));
}

/** Apify reports real per-run cost as `usageTotalUsd` (whole dollars, float). */
function centsFromUsd(usd: number): number {
  return Math.round(usd * 100);
}

/**
 * Build a noelle.llm_calls SpendRow for one Apify actor run, so Apify cost is
 * metered alongside LLM cost for VISIBILITY (shows on the dashboard) — but it is
 * NOT counted toward any budget cap. The cap reader
 * (./pgBudgetAdapters.ts) exempts it in every intern — "apify" is in both
 * CAP_EXEMPT_ENGINES_APIFY and CAP_EXEMPT_ENGINES_APIFY_XAPI — so Apify
 * spend can never trip a limit or pause the pipeline; only LLM spend counts.
 * engine="apify"; tokens are 0 (per-result billing); the actor is recorded as the
 * model and the worker drives the bucket (e.g. "apify-drafter").
 */
export function apifySpendRow(args: {
  orgId: string;
  instanceId: string | null;
  agentRole: AgentRole;
  /** The worker that made the call: "discovery" | "profiler" | "drafter". */
  worker: string;
  /** Bare actor slug, e.g. "linkedin-post-comments". */
  actor: string;
  resultCount: number;
  /**
   * Apify's REAL cost for this run in USD (`usageTotalUsd` off the run object).
   * When a finite value >= 0 is passed it is the source of truth (rounded to
   * whole cents); the per-result estimate is used only as a fallback when it is
   * absent/null/NaN/negative. Prefer always passing this — the estimate drifts.
   *
   * Explicitly `| undefined` so an explicitly-undefined property is accepted,
   * not just an absent one: under `exactOptionalPropertyTypes` a bare `?:`
   * rejects `{ ...base, actualUsd: undefined }` (apifyPrices.test.ts:95), which
   * left this package's own `tsc --noEmit` red. The guard below keys off
   * `typeof === "number"`, so undefined/null/NaN/negative all mean the same
   * thing here — the type now matches that contract instead of singling out
   * undefined. Production callers still normalize with `?? null`; keep doing
   * that, since `drainLastRunUsd?.()` is `number | null | undefined`.
   */
  actualUsd?: number | null | undefined;
  startedAt: Date;
  latencyMs?: number | null;
  /** noelle.connections row id of the token that paid, for per-token spend. */
  credentialId?: string | null;
}): SpendRow {
  const hasReal =
    typeof args.actualUsd === "number" && Number.isFinite(args.actualUsd) && args.actualUsd >= 0;
  return {
    orgId: args.orgId,
    instanceId: args.instanceId,
    agentRole: args.agentRole,
    worker: args.worker,
    engine: "apify",
    model: `apify/${args.actor}`,
    bucket: `apify-${args.worker}`,
    inputTokens: 0,
    outputTokens: 0,
    cents: hasReal ? centsFromUsd(args.actualUsd as number) : estimateApifyCents(args.actor, args.resultCount),
    costBasis: hasReal ? "provider_reported" : "unknown",
    latencyMs: args.latencyMs ?? null,
    status: "ok",
    startedAt: args.startedAt,
    credentialId: args.credentialId ?? null,
  };
}

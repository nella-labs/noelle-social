import type { EngagementKind } from "./engagement.js";

// Re-export so callers can `import { EngagementKind } from "../lib/types.js"`
// alongside ActuatorConfig without reaching into engagement.js directly.
export type { EngagementKind } from "./engagement.js";

// Shared engine vocabulary (unchanged from the X/LinkedIn actuators): "comment"
// is the generic write action — for the REDDIT actuator it posts a REPLY (under a
// post or a comment). "like" and "dm" are part of the shared ActionKind union but
// are NEVER planned as scheduled slots for Reddit (the scheduler is fed
// targetLikes:0 and caps.likes:0, so it emits zero like slots) and Reddit DMs are
// out of scope. UPVOTING is handled OUTSIDE the scheduler: the operator opted into
// idle-upvotes (see ActuatorConfig.upvotesEnabled) which fire in the WAITS between
// replies, hard-capped to ≤10 per rolling 15 min — UPVOTE-ONLY, never a downvote.
export type ActionKind = "like" | "comment" | "dm";

export interface ActuatorConfig {
  apiBaseUrl: string;     // api-vm base, e.g. http://127.0.0.1:18791
  token: string;          // static actuator bearer token
  instanceId: string;     // Reddit (Orion) agent instance id
  // Daily backstop ceilings. Only `comments` (replies) is live on Reddit and it
  // is additionally clamped to the Reddit-safe REDDIT_DEFAULTS.repliesPerDay (8)
  // in startRun; `likes`/`dms` are inert (forced to 0 — no voting, no DMs).
  caps: { likes: number; comments: number; dms: number };
  maxWritesPerHour?: number;      // hard ceiling on reply actions per rolling hour (Reddit default 3)
  preferWatchlistRatio: number;   // INERT on Reddit (was the like-watchlist bias; Reddit never likes)
  deepNightTaper: boolean;
  ambientReadActions?: boolean;   // expand "…more" + open threads while idle-browsing (default ON; read-only, non-counted)
  drainShortBandProb?: number;    // Drain mode: share of inter-reply gaps drawn from the short 1–60s band vs 60–120s (default 0.55)
  // Which Reddit interface the actuator posts through. DEFAULT is new Reddit
  // (www.reddit.com) — the interface most operators actually browse, so the
  // account's write interface stays consistent with its reads (blend-in, less
  // detectable). Set true ONLY if you genuinely live on old.reddit.com: doReply
  // then rewrites www.reddit.com → old.reddit.com before navigating. old Reddit is
  // easier to automate but a more conspicuous, distinct write surface, so it is
  // opt-in — never the default.
  preferOldReddit?: boolean;
  // Policy flag (documented default OFF): the actuator never adds links, and the
  // approved body is typed VERBATIM, so this is not enforced by mutating the body
  // (that would corrupt an approved draft) — it records the drafting-side policy.
  externalLinks?: boolean;
  // UPVOTING (operator opt-in; DEFAULT ON — the operator explicitly overrode the
  // prior no-vote default). When enabled, the actuator slips idle-UPVOTES into the
  // waits between replies (mirroring the LinkedIn idle-like path), hard-capped to
  // `upvotesPer15Min` per rolling 15-minute window with a ~60s min-gap so they
  // never cluster. UPVOTE-ONLY — there is no downvote path anywhere. Set
  // upvotesEnabled:false to fully disable voting. undefined ⇒ ON.
  upvotesEnabled?: boolean;
  upvotesPer15Min?: number;       // rolling-15-min upvote cap (default 10)
  // Idle-engagement variety (operator opt-in; DEFAULT-OFF). Per-kind relative
  // weights overriding lib/engagement's defaults { upvote: 100, save: 0 }. ABSENT
  // ⇒ upvote-only, byte-identical to the pre-save behavior (an all-zero table
  // also collapses to a plain upvote). When the operator raises `save`, the
  // actuator occasionally mixes a post-SAVE (a private bookmark — NOT a vote, so
  // it never touches the vote-manipulation ToS clause a downvote would) into the
  // idle engagement, drawing from the SAME canUpvote rolling-15-min budget +
  // min-gap as an upvote (no extra velocity, no second budget), and FALLING BACK
  // to a plain upvote on any save-find/click miss so the engagement is never
  // lost. SAVE-ONLY — the EngagementKind enum is { upvote, save }; there is no
  // downvote kind anywhere. Idle-only, exactly like an upvote (never reply-coupled).
  engagementWeights?: Partial<Record<EngagementKind, number>>;
  // Lights-out autonomy: auto-start one run per day inside the operating window.
  autonomous?: boolean;
  // Lights-out inbox clearing (requires `autonomous`; DEFAULT OFF): start a drain
  // whenever the server serves approved replies and nothing is running, inside the
  // same operating window. Consent to post stays SERVER-SIDE and standing
  // (agent_instances.auto_send_enabled, dashboard-set) — the unattended path never
  // arms reply_send_enabled itself, so Pause-all remains authoritative.
  autoDrain?: boolean;
  // Stalled-run recovery: if a run is "running" but makes no progress for this
  // many minutes while drafts are loaded + comment slots overdue, supersede it
  // with a fresh drain (shouldRecoverStalledRun). Requires autoDrain. Default 30
  // (STALL_RECOVER_MIN): the drain-cooldown band reaches ~19 min, so the floor
  // sits above it to keep the stall probe off a healthy drain's legitimate gaps.
  stallRecoverMinutes?: number;
  autoStartHour?: number;         // operating window start hour, local (default 9)
  autoEndHour?: number;           // operating window end hour, local (default 21)
  autoWindowHours?: number;       // run window length in hours (default 8)
  autoTargetComments?: number;    // daily auto-run reply target (default 8, capped Reddit-safe)
  autoTargetLikes?: number;       // INERT on Reddit (forced to 0 — no voting)
  challengeCooldownDays?: number; // days to skip auto-start after a challenge halt (default 3)
  healthGate?: boolean;           // require server /health status 'ok' before auto-start (default true)
  autoChallengeBackoffDays?: number; // extra post-challenge auto-start backoff, in shouldAutoStart (default undefined/0 = OFF)
  // Chrome Bridge observability sink (docs/chrome-bridge.md). Observability only;
  // never touches the send path. Defaults: bridgeUrl http://127.0.0.1:18792,
  // bridgeSink ON. Set bridgeSink:false to disable log/heartbeat mirroring.
  bridgeUrl?: string;
  bridgeSink?: boolean;
}

/**
 * Reddit-specific pacing defaults, grounded in Reddit's official rate-limit
 * guidance. Single source of truth for the caps/pacing floors applied in the
 * background: a conservative 8 replies/day (warm-up ramps it up over ~4 weeks via
 * the shared warmup multiplier), no more than 3 writes/hour, and a hard 240s (4
 * min) minimum between replies. The inter-reply gap (drain mode + the scheduled
 * floor) is `replyBaseGapMs + uniformRandom(0, replyRandGapMs)` = 4 min + 0–900s,
 * so 4–19 min between replies. UPVOTES are idle-only + operator opt-in, capped to
 * `upvotesPer15Min` per rolling 15 min with an `upvoteMinGapMs` floor — UPVOTE-ONLY,
 * never a downvote. Active-hours-only is enforced by the curfew + autonomy window.
 */
export const REDDIT_DEFAULTS = {
  repliesPerDay: 8,
  maxWritesPerHour: 3,
  minReplySpacingMs: 240_000,        // 4 min hard floor between replies (scheduled mode)
  replyBaseGapMs: 240_000,           // base inter-reply gap (4 min)
  replyRandGapMs: 900_000,           // uniform random added on top (0–900s / 0–15 min)
  targetSpacingMinMs: 20 * 60_000,   // 20 min
  targetSpacingMaxMs: 60 * 60_000,   // 60 min
  upvotesPer15Min: 10,               // hard cap: ≤10 upvotes per rolling 15-min window
  upvoteMinGapMs: 60_000,            // ≥60s between idle-upvotes (no clustering)
  preferOldReddit: false, // new Reddit by default — match the operator's own read interface (blend-in)
  externalLinks: false,
} as const;

export interface RunParams {
  windowHours: number;
  targetComments: number;
  targetLikes: number;
}

export interface PlannedAction {
  kind: ActionKind;
  atMs: number;           // absolute epoch ms to fire
}

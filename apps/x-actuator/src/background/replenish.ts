import type { Rng } from "../lib/rng.js";
import type { PlannedAction } from "../lib/types.js";

export type PoolItem = {
  approvalId: string; draftId: string; body: string; url: string;
  /**
   * How many times posting this draft has failed this session WITHOUT a submit
   * gesture being dispatched (see replyFailureDecision). A failed reply used to
   * be `unshift`-ed back to the FRONT of the pool, so a single tweet the
   * composer/submit couldn't handle was retried on every subsequent slot —
   * monopolizing the lane and starving every other pending draft (and
   * repeatedly re-navigating to the same dead permalink, a bot tell; Lyra's
   * "wall of comment-failed" symptom, fixed on LinkedIn in #437). Now a
   * failure bumps `tries` and pushes the item to the BACK (others go first);
   * once it reaches MAX_ACTION_TRIES the draft is dropped for the session so
   * it can never block the lane. Survives replenish because mergePool keeps
   * existing items untouched. Optional so old persisted states load.
   */
  tries?: number;
};

/** Per-session cap on how many times one draft may fail to post before it's
 * dropped for the session. Small on purpose: a draft that misses this many
 * times is almost always a bad target (odd composer, deleted-but-not-flagged
 * tweet, or a live action-block) — retrying it further only starves healthy
 * drafts. */
export const MAX_ACTION_TRIES = 3;

/** Decide what to do with a reply draft that just failed BEFORE any submit
 * gesture. Pure so it is unit-testable: `giveUp` means drop the draft for the
 * session (it has failed `MAX_ACTION_TRIES` times); otherwise re-queue it at
 * the BACK of the pool so healthy drafts go first. */
export function retryDecision(priorTries: number, maxTries = MAX_ACTION_TRIES): { tries: number; giveUp: boolean } {
  const tries = priorTries + 1;
  return { tries, giveUp: tries >= maxTries };
}

/** Safety ceiling on drain auto-continue BATCHES — a batch is one round that
 * actually appended reply slots for pending approvals. Persistent-drain empty
 * waits (see drainShouldKeepWaiting) do NOT count, so a Drain that idles for hours
 * waiting on supply never burns this; only real refill-and-send cycles do. Set far
 * above any real day (server-side daily/per-author caps starve supply long before
 * 1000 batches) so the operator's one Drain click is effectively "never re-click"
 * — the ceiling is a runaway backstop, not a normal stop. */
export const MAX_DRAIN_ROUNDS = 1000;

/** Pure decision: should a drain that just finished its planned slots append
 * another batch instead of ending? Yes only in drain mode, under the round cap,
 * and while replies still remain in the (freshly-replenished) pool. */
export function shouldExtendDrain(
  mode: string | undefined,
  rounds: number,
  remaining: number,
  maxRounds = MAX_DRAIN_ROUNDS,
): boolean {
  return mode === "drain" && rounds < maxRounds && remaining > 0;
}

/** Pure decision: when a drain has caught up (inbox momentarily empty, or supply
 * withheld by a server-side gate this instant), should the run STAY ALIVE and keep
 * watching for new approvals instead of ending? Yes for ANY drain under the batch
 * ceiling — the operator's Drain click AND the unattended auto-drain.
 *
 * Auto-drain is included deliberately: its old lifecycle ended on an empty inbox
 * and leaned on the autonomy tick to restart it, costing up to a 30-min re-arm per
 * cycle — and on X it meant Vega simply did not run for whole days. A persistent
 * drain just stays up and watches, so an approval goes out ~a minute after it
 * lands. This is safe only because a dry run now goes QUIET (see pipelineIsDry)
 * instead of burning idle-likes while it waits.
 *
 * It does NOT override the real end paths — STOP, a challenge halt, and the batch
 * ceiling all still end the run through their own code; this only suppresses the
 * end-on-empty transition. */
export function drainShouldKeepWaiting(
  mode: string | undefined,
  rounds: number,
  maxRounds = MAX_DRAIN_ROUNDS,
): boolean {
  return mode === "drain" && rounds < maxRounds;
}

/**
 * What /api/actuator/approval-state/:id reported for an approval, or null when
 * the check itself failed (network error, non-2xx, malformed body).
 */
export type ApprovalState = { status: string; autosend_pending: boolean } | null;

export type PreSendDecision =
  | { action: "post" }
  /** Drop the draft locally (doneDraftIds, executed) — decided or owned
   * elsewhere. NO markSent (this client posted nothing) and NO markSkipped
   * (never clobber another actor's decision/claim). */
  | { action: "drop"; reason: string }
  /** Fail closed: could not verify — treat as a transient failure (re-queue
   * under the MAX_ACTION_TRIES cap), never post unverified. */
  | { action: "retry"; reason: string };

/**
 * Decide whether a queued reply may still be posted, from a JUST-fetched
 * approval state. Pool items can sit queued for minutes-to-hours after the
 * queue fetch; in that window the approval can be decided elsewhere (human
 * skip/sent) or claimed by the x-intern API-autosend pipeline (a stamped
 * auto_send_target_at means claimAutoSendDue will post it via the official
 * API). Posting anyway would duplicate a public reply — so anything other than
 * a verified pending+unstamped approval refuses to post. Pure/unit-tested.
 */
export function preSendDecision(st: ApprovalState): PreSendDecision {
  if (!st || typeof st.status !== "string") return { action: "retry", reason: "verify-unreachable" };
  if (st.status !== "pending") return { action: "drop", reason: `superseded-${st.status}` };
  if (st.autosend_pending) return { action: "drop", reason: "autosend-owned" };
  return { action: "post" };
}

export type ReplyFailurePlan =
  | { plan: "drop-ambiguous" }
  | { plan: "give-up"; tries: number }
  | { plan: "retry-back"; tries: number };

/**
 * Decide what to do with a reply draft that just reported failure.
 *
 * `submitDispatched` is the safety pivot: once a submit gesture (the
 * tweetButton click OR a ⌘/Ctrl+Enter chord) has been fired, ok:false only
 * means the composer never READ cleared — the post itself is AMBIGUOUS. X can
 * land a post slower than the observation window, and composer drift could
 * leave text readable after a success. Retrying an ambiguous draft re-opens
 * the tweet, re-types, and re-submits the SAME reply — N duplicate replies on
 * one tweet is the exact spam signal this extension exists to prevent
 * (docs/x-account-safety.md, reply-spam purges). So a dispatched failure is
 * NEVER retried — in-session OR cross-session: the draft is dropped locally
 * (no markSent — nothing was confirmed), the caller stamps the tweet into
 * actionedUrls so sibling drafts for the same tweet are dropped as
 * duplicate-post, and the skip row it logs carries the tweet_id, which the
 * server dedup (/api/actionable-x + migration 0086) counts as reply evidence —
 * so the still-pending approval is never served again either. The operator
 * reconciles it by hand (mark sent or reject).
 *
 * Pre-dispatch failures (box-not-found / stopped before any gesture) posted
 * nothing, so they retry — but bounded (MAX_ACTION_TRIES) and re-queued at the
 * BACK, so one bad target can't starve the pool.
 */
export function replyFailureDecision(submitDispatched: boolean, priorTries: number, maxTries = MAX_ACTION_TRIES): ReplyFailurePlan {
  if (submitDispatched) return { plan: "drop-ambiguous" };
  const { tries, giveUp } = retryDecision(priorTries, maxTries);
  return giveUp ? { plan: "give-up", tries } : { plan: "retry-back", tries };
}

export function mergePool(existing: PoolItem[], incoming: PoolItem[], doneDraftIds: Set<string>): PoolItem[] {
  const have = new Set(existing.map((i) => i.draftId));
  const out = [...existing];
  for (const it of incoming) {
    if (have.has(it.draftId) || doneDraftIds.has(it.draftId)) continue;
    have.add(it.draftId);
    out.push(it);
  }
  return out;
}

// Re-schedule a due-but-unsupplied action to a later jittered time in the window.
export function deferLater(action: PlannedAction, nowMs: number, windowEndMs: number, rng: Rng): PlannedAction {
  const remaining = Math.max(0, windowEndMs - nowMs);
  // wait between ~1 min and ~15% of the remaining window, capped at the end
  const wait = Math.min(remaining, rng.float(60_000, Math.max(60_000, remaining * 0.15)));
  return { kind: action.kind, atMs: Math.min(windowEndMs, Math.round(nowMs + wait)) };
}

export function shortfall(target: number, done: number): number {
  return Math.max(0, target - done);
}

/** Pure decision: is there nothing left to SEND right now (both pools empty)?
 * A run in this state must go QUIET — no idle-likes, no ambient browsing — rather
 * than keep engaging to look busy. This is deliberately about SUPPLY, not about
 * unexecuted slots: a scheduled run holds comment slots that are merely waiting on
 * drafts, and liking through that wait is what produced 346 likes against 3
 * comments in a day. The persistent drain keeps watch-polling while quiet, so work
 * resumes the instant an approval lands. */
export function pipelineIsDry(commentPoolLen: number, dmPoolLen: number): boolean {
  return commentPoolLen === 0 && dmPoolLen === 0;
}

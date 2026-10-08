import type { Rng } from "../lib/rng.js";
import type { PlannedAction } from "../lib/types.js";

export type PoolItem = {
  approvalId: string; draftId: string; body: string; url: string;
  /**
   * THREADING TARGET (notification leads only): the urn of the comment this
   * reply answers. Present ⇒ the actuator must open THAT comment's reply box.
   * It never falls back to the post composer, because a conversation reply
   * posted at post level is a duplicate top-level comment on a thread we
   * already commented on.
   */
  commentUrn?: string | null;
  /** Who wrote that comment — checked against the reply box's mention chip. */
  commentAuthorName?: string | null;
  /**
   * How many times posting this draft has failed this session. A failed comment
   * used to be `unshift`-ed back to the FRONT of the pool, so a single post the
   * composer/submit couldn't handle was retried on every subsequent slot —
   * monopolizing the lane and starving every other pending draft (the live
   * "wall of comment-failed" symptom). Now a failure bumps `tries` and pushes the
   * item to the BACK (others go first); once it reaches MAX_ACTION_TRIES the draft
   * is dropped for the session so it can never block the lane. Survives replenish
   * because mergePool keeps existing items untouched.
   */
  tries?: number;
  /** Queue omissions checked during this run. A pending approval can be hidden
   * by a temporary server gate; bounded retries prevent permanent local wedges. */
  withheldChecks?: number;
};

/** Per-session cap on how many times one draft may fail to post before it's
 * dropped for the session. Small on purpose: a draft that misses this many times
 * is almost always a bad target (odd composer, deleted-but-not-flagged post, or a
 * live action-block) — retrying it further only starves healthy drafts. */
export const MAX_ACTION_TRIES = 3;

/** Decide what to do with a comment/DM draft that just failed to post. Pure so it
 * is unit-testable: `giveUp` means drop the draft for the session (it has failed
 * `MAX_ACTION_TRIES` times); otherwise re-queue it at the BACK of the pool. */
export function retryDecision(priorTries: number, maxTries = MAX_ACTION_TRIES): { tries: number; giveUp: boolean } {
  const tries = priorTries + 1;
  return { tries, giveUp: tries >= maxTries };
}

/** Safety ceiling on drain auto-continue BATCHES — a batch is one round that
 * actually appended comment slots for pending approvals. Persistent-drain empty
 * waits (see drainShouldKeepWaiting) do NOT count, so a Drain that idles for hours
 * waiting on supply never burns this; only real refill-and-send cycles do. Set far
 * above any real day (server-side daily/per-author caps starve supply long before
 * 1000 batches) so the operator's one Drain click is effectively "never re-click"
 * — the ceiling is a runaway backstop, not a normal stop. */
export const MAX_DRAIN_ROUNDS = 1000;

/** Pure decision: should a drain that just finished its planned slots append
 * another batch instead of ending? Yes only in drain mode, under the round cap,
 * and while comments still remain in the (freshly-replenished) pool. */
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
 * cycle and churning 8-11 short sessions a day. A persistent drain just stays up
 * and watches, so an approval goes out ~a minute after it lands. This is safe only
 * because a dry run now goes QUIET (see pipelineIsDry) instead of burning
 * idle-likes while it waits.
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
  // wait between ~1 min and ~22% of the remaining window, capped at the end
  const wait = Math.min(remaining, rng.float(60_000, Math.max(60_000, remaining * 0.22)));
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

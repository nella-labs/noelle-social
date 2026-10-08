import type { RunState, SlotAction, RedditPoolItem } from "./state.js";
import type { RedditActivityEvent } from "@noelle/contracts";
import { postDedupKey } from "../lib/urn.js";

/**
 * Record a successful reply LOCALLY FIRST — before any network call. Mirrors the X
 * actuator's record-first pattern: the moment doReply returns true we mark the slot
 * executed, remember the draft so replenish/mergePool can NEVER re-queue it, bump
 * the done counter, anchor the min-spacing floor, and record the thread's dedup key
 * so the per-thread guard drops any second draft for this thread this session. A
 * markSent() failure AFTER this must not undo it — otherwise the still-pending
 * approval is re-served and the comment is posted a SECOND time (a Reddit ban
 * trigger).
 */
export function recordReplySuccess(s: RunState, action: SlotAction, item: RedditPoolItem, now: number): void {
  s.doneDraftIds.push(item.draftId);
  action.executed = true;
  s.done.comments++;
  s.lastProgressMs = now; // a landed reply = progress; the stall detector reads this
  s.lastReplyMs = now; // anchor the min-spacing floor
  const dk = postDedupKey(item.url);
  if (dk) (s.actionedKeys ??= []).push(dk); // per-THREAD guard key (never reply twice in one thread)
}

/**
 * Record a "target thread can never take this reply" skip — the reply was NEVER
 * posted because the thread was removed/deleted/unavailable, its comments are
 * locked, or the post is archived (doReply returned a "removed"-kind outcome
 * BEFORE touching the composer). This is a terminal SKIP, not a retry: consume the
 * slot, remember the draft so replenish/mergePool can NEVER re-queue this dead
 * post this session, and return the activity event to log with the cause-specific
 * `reason` (post-removed | post-unavailable | comments-locked | post-archived —
 * the same string the caller passes to markSkipped when the outcome is durable,
 * so the dashboard shows WHY the draft vanished). `post-unavailable` (shell
 * absent, no positive removal evidence) is the one reason that must stay
 * session-local — see classifyRemovedProbe.
 * Deliberately does NOT bump done.comments (no reply happened), does NOT stamp
 * lastReplyMs (the min-spacing floor is unaffected), and never calls markSent.
 * Pure state mutation — it performs NO composer/DOM interaction, mirroring
 * recordReplySuccess.
 */
export function recordRemovedSkip(
  s: RunState,
  action: SlotAction,
  item: RedditPoolItem,
  at: string,
  reason = "post-removed",
): RedditActivityEvent {
  action.executed = true;
  s.doneDraftIds.push(item.draftId);
  return { type: "skip", reason, at };
}

/** The wire result of the content script's `checkPostRemoved` probe. */
export interface RemovedProbe {
  removed?: boolean;
  reason?: string;
  /** Set by the content script ONLY on positive removal evidence (attr/class/phrase). */
  positive?: boolean;
}

/**
 * Classify a `checkPostRemoved` probe into a reply outcome — the gate that decides
 * whether the skip may become DURABLE. `api.markSkipped` flips the approval
 * pending→'skipped' server-side, irreversibly discarding a HUMAN-APPROVED reply,
 * so it is only allowed on POSITIVE removal evidence (`positive: true`: a
 * removed/deleted attribute, old Reddit's `.thing.link.deleted`, or a matched
 * removal phrase). A merely-absent post shell (`post-absent`) ALSO fires on
 * transient 5xx / "something went wrong" interstitials, CDN error pages, and
 * old-Reddit age gates where the content script runs fine — that stays a
 * SESSION-LOCAL drop (`durable: false`, reason `post-unavailable`) that self-heals
 * on the next run, exactly the pre-durable-skip behavior. A missing `positive`
 * field (e.g. a stale content script) fails CLOSED to non-durable.
 */
export function classifyRemovedProbe(
  rem: RemovedProbe | null | undefined,
): { kind: "removed"; reason: string; durable: boolean } | null {
  if (!rem?.removed) return null;
  if (rem.positive === true) return { kind: "removed", reason: "post-removed", durable: true };
  return { kind: "removed", reason: "post-unavailable", durable: false };
}

// The minimal surface markSentWithRetry needs from ActuatorApi — structural so the
// helper stays decoupled (and trivially mockable in tests).
interface MarkSentApi {
  markSent(approvalId: string): Promise<void>;
  logActivity(sessionId: string, events: RedditActivityEvent[]): Promise<void>;
}

/**
 * Tell the server the approval was sent, with a bounded retry + backoff. The local
 * success record already happened (recordReplySuccess), so a total failure here is
 * only a server-bookkeeping miss: log it to the activity/skip channel and NEVER
 * throw — throwing after a real post would let the tick re-queue the item and
 * double-post. Returns whether markSent ultimately stuck.
 */
export async function markSentWithRetry(
  api: MarkSentApi,
  approvalId: string,
  sessionId: string,
  rng: { float(min: number, max: number): number },
  sleepFn: (ms: number) => Promise<void>,
  attempts = 3,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await api.markSent(approvalId);
      return true;
    } catch (e) {
      if (attempt < attempts - 1) {
        await sleepFn(rng.float(400, 1200) * (attempt + 1)); // linear backoff
      } else {
        await api
          .logActivity(sessionId, [{ type: "skip", reason: "marksent-failed", at: new Date().toISOString() }])
          .catch(() => {});
        console.warn(
          "[actuator] markSent failed after retries (recorded locally; will NOT re-post):",
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
  return false;
}

/** Retain a dispatched or possibly admitted attempt without claiming a successful reply. */
export function recordReplyHold(s: RunState, action: SlotAction, item: RedditPoolItem): void {
  action.executed = true;
  s.doneDraftIds.push(item.draftId);
  const key = postDedupKey(item.url);
  if (key) (s.actionedKeys ??= []).push(key);
}

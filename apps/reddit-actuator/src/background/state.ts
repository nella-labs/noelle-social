import { createSessionRunStateStore, tickIsCurrent } from "@noelle/actuator-cdp";
export { tickIsCurrent };

import type { ActionKind } from "../lib/types.js";
import type { PoolItem } from "./replenish.js";
import type { SessionPersona } from "../lib/session.js";
import type { DrainArchetype } from "../lib/scheduler.js";

const HOUR = 3600_000;

/**
 * A Reddit pool item — the shared-engine PoolItem ({approvalId, draftId, body,
 * url}) plus the Reddit-native target so doReply knows whether to reply under the
 * source POST or under a specific COMMENT (and which one). Threaded from
 * api.ts's EngineQueueItem through startRun/replenish. `targetType` never carries
 * a vote — Reddit is reply-only.
 */
export interface RedditPoolItem extends PoolItem {
  targetType: "post" | "comment";
  commentId?: string; // the t1 id (prefix stripped) when targetType === "comment"
}

export interface SlotAction { kind: ActionKind; atMs: number; executed: boolean; }

// Earliest unexecuted slot whose time has passed. Scans (slots get re-timed by
// deferral, so the array is not assumed sorted). Returns -1 if none due.
export function dueActionIndex(actions: SlotAction[], nowMs: number): number {
  let best = -1;
  let bestAt = Infinity;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    if (!a.executed && a.atMs <= nowMs && a.atMs < bestAt) { best = i; bestAt = a.atMs; }
  }
  return best;
}

export function withinWindow(startMs: number, windowHours: number, nowMs: number): boolean {
  return nowMs <= startMs + windowHours * HOUR;
}

export interface RunState {
  sessionId: string;
  /**
   * Monotonic run generation. Every startRun and every endRun bumps the shared
   * epoch (see epoch helpers below) and stamps the resulting state with it. A
   * tick captures the epoch it loaded and refuses to act on or save back a state
   * whose epoch is no longer current — that is what makes STOP authoritative and
   * stops a second Run (or an ephemeral-SW-restart race) from resurrecting a
   * superseded plan.
   */
  epoch: number;
  startMs: number;
  windowHours: number;
  actions: SlotAction[];
  targets: { likes: number; comments: number; dms: number };
  done: { likes: number; comments: number; dms: number };
  commentPool: RedditPoolItem[];
  dmPool: RedditPoolItem[];
  doneDraftIds: string[];
  /**
   * Per-THREAD dedup keys (lib/urn.ts postDedupKey — `t3_<id>` or the raw URL)
   * of every reply posted this session. Checked before doReply so a second draft
   * targeting the same thread (Orion can queue >1 per thread; two comments by
   * one account in one thread is a classic subreddit-ban trigger) is dropped as
   * done, never posted. Optional so a persisted pre-upgrade RunState still loads
   * (readers use `s.actionedKeys ?? []` / `(s.actionedKeys ??= [])`). The
   * server-side dedup-by-thread covers the cross-session case; this is the fast
   * in-run guard.
   */
  actionedKeys?: string[];
  lastPollMs: number;
  status: "running" | "idle" | "stopped" | "halted-challenge";
  /**
   * Run mode. "scheduled" (default/undefined) spreads a target over a window;
   * "drain" posts every approved reply a short gap apart (Drain all approvals),
   * returning to the feed after each reply so the gap browses + likes.
   */
  mode?: "scheduled" | "drain";
  /**
   * How many auto-continue batches this drain has appended (see maybeExtendDrain;
   * capped at MAX_DRAIN_ROUNDS so a forever-refilling queue can't loop
   * unattended). Undefined ⇒ 0 (pre-upgrade state / scheduled runs).
   */
  drainRounds?: number;
  /**
   * ms of the last persistent-drain "watch" poll — when a drain has caught up
   * (inbox empty) the run stays alive and re-checks the server queue no more often
   * than DRAIN_WATCH_POLL_MS, so a reply approved later goes out with no re-click.
   * Undefined ⇒ never watched yet (poll immediately).
   */
  lastDrainWatchMs?: number;
  /**
   * True when this drain was started by the operator clicking "Drain all
   * approvals" (startDrain opts.manual), not the unattended auto-drain. ONLY a
   * manual drain is persistent (drainShouldKeepWaiting): it never ends on an empty
   * inbox and watches for new approvals. The auto-drain keeps its once-per-supply
   * lifecycle. Undefined ⇒ not a manual drain (auto-drain / scheduled / old state).
   */
  manualDrain?: boolean;
  /**
   * Per-session drain temperament (gap-band mix + long-break proneness) drawn once
   * at startDrain and persisted so maybeExtendDrain plans every round with the SAME
   * mood — the tick rng is wall-clock-reseeded each tick, so an unpersisted
   * archetype would re-roll per round and the session would have no coherent
   * character. TIMING-ONLY on Reddit (reply-only drain: no like/vote knob). JSON-
   * safe ({ bandWeights, longBreakMs }). Optional: old persisted states and
   * scheduled runs load without it, and planDrainTimeline falls back to today's
   * exact defaults. See pickDrainArchetype in lib/scheduler.
   */
  drainStyle?: DrainArchetype;
  lastEvent?: string; // human-readable last tick outcome, surfaced in the panel
  /** Stable session persona (tempo, wpm, tremor, ρ, …) drawn once at startRun. */
  persona: SessionPersona;
  /** Writes are read-only-suppressed for the first this-many ms (warm-up). */
  warmupSuppressMs: number;
  /**
   * Epoch ms of the last successful post (comment or DM) — the run's "last
   * progress" marker. The autonomy loop's stall-recovery reads it: a run that is
   * "running" but hasn't progressed for a long time while drafts are loaded and
   * comment slots are overdue is wedged, and gets superseded by a fresh drain
   * (shouldRecoverStalledRun). Undefined until the first post; the detector then
   * falls back to startMs, so a run that never posts is judged from its start.
   */
  lastProgressMs?: number;
  /**
   * Epoch ms of the last ambient read-action (expand "…more" / open comments).
   * Rolling cooldown anchor so these decoys cluster like real reading instead of
   * firing every tick. Undefined until the first read-action of the session.
   */
  lastAmbientReadMs?: number;
  /**
   * Epoch ms of the last successful reply. Anchors the Reddit min-spacing hard
   * floor (default 240s / 4 min) enforced in the tick loop for scheduled runs — a
   * reply that lands too soon after the previous one is deferred, never fired. Not
   * applied in drain mode (an explicit operator "post everything now" action).
   */
  lastReplyMs?: number;
  /**
   * The tab this run is PINNED to. Picked once at startRun/startDrain and reused
   * every tick (findRedditTab passes it to chooseActuatorTab), so another reddit
   * tab that merely sorts first — the operator's own permalink/profile tab —
   * can never hijack the run mid-flight. Re-picked only when the pinned tab has
   * closed. Optional: absent on pre-upgrade states and when no tab was open at
   * run start (the next tick pins whatever findRedditTab chooses).
   */
  tabId?: number;
  /**
   * Epoch ms of every successful idle-UPVOTE this session (init []). The rolling
   * 15-minute window over this array enforces the ≤10-upvotes/15-min hard cap, and
   * its max element anchors the ~60s min-gap between upvotes (see canUpvoteNow).
   * Trimmed to the window after each upvote so it can't grow unbounded. UPVOTE-ONLY
   * — a downvote is never performed, so it is never recorded here.
   */
  upvoteAtMs?: number[];
  /**
   * Epoch ms of the last idle-upvote ATTEMPT (successful or not). The ~60s
   * min-gap paces off this too, not only off successes (upvoteAtMs) — the
   * locateUpvote scan is costly, so a like-less feed must not be re-scanned on
   * every ~4s idle tick. Undefined until the first attempt of the session.
   */
  lastUpvoteAttemptMs?: number;
  /**
   * True iff THIS run armed the master reply switch: it was a manual Run/Drain
   * whose enable-send POST landed AND the server reported the flag was OFF
   * before it (prior=false) — i.e. this run performed the OFF→ON transition
   * (see armedByManualEnable). endRun only disarms when this is set (see
   * shouldDisableSendOnRunEnd) — an autonomous run never arms, and a manual run
   * whose enable was a no-op against an ALREADY-ON flag (the operator's
   * standing dashboard toggle, the documented lights-out consent) must never
   * flip that toggle OFF at run end. Unlike LinkedIn, GET /api/actionable-reddit
   * gates on reply_send_enabled ONLY (no auto_send_enabled lights-out fallback),
   * so disarming a switch this run didn't turn on would silently starve every
   * subsequent autonomous run.
   */
  armedSend?: boolean;
  /**
   * Idle-upvote min-gap jitter multiplier (×1–1.8), drawn ONCE at run start and
   * held for the session. Drawing it per tick re-rolls the multiplier every ~4s,
   * which biases the effective gap toward the 60s floor (the gate passes as soon
   * as one low draw lands) and collapses the intended spread. ≥1 always — the
   * 60s floor is a safety bound and is never lowered; pre-upgrade states
   * (undefined) fall back to ×1 (the floor itself).
   */
  upvoteGapJitter?: number;
}

/**
 * Pure guard: did a manual Run/Drain's landed enable-send actually ARM the
 * switch — i.e. perform the OFF→ON transition itself? `prior` is the
 * server-reported value of reply_send_enabled BEFORE the enable write:
 *   prior === false     → the flag was OFF; this run turned it ON. Armed: endRun
 *                         (or the failed-start rollback) owns flipping it back.
 *   prior === true      → the flag was ALREADY ON — the operator's standing
 *                         dashboard consent (the documented lights-out
 *                         workflow). The enable was a no-op; NOT armed, so run
 *                         end must leave the switch alone.
 *   prior === undefined → an older api-vm that doesn't report prior. Fail-safe:
 *                         treat as prior=true — never disarm what might be
 *                         standing consent. (Fail direction stays closed for
 *                         posting: nothing is ever POSTED without the flag; the

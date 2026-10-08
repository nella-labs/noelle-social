import { createSessionRunStateStore, tickIsCurrent } from "@noelle/actuator-cdp";
export { tickIsCurrent };

import type { ActionKind } from "../lib/types.js";
import type { PoolItem } from "./replenish.js";
import type { SessionPersona } from "../lib/session.js";
import type { DrainArchetype } from "../lib/scheduler.js";
import type { LikeSkipState } from "../lib/like-skip.js";
import type { VisiblePost } from "../content/discovery.js";

const HOUR = 3600_000;

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
  commentPool: PoolItem[];
  dmPool: PoolItem[];
  doneDraftIds: string[];
  lastPollMs: number;
  status: "running" | "idle" | "stopped" | "halted-challenge";
  lastEvent?: string; // human-readable last tick outcome, surfaced in the panel
  /** Stable session persona (tempo, wpm, tremor, ρ, …) drawn once at startRun. */
  persona: SessionPersona;
  /** Writes are read-only-suppressed for the first this-many ms (warm-up). */
  warmupSuppressMs: number;
  /**
   * Epoch ms of the last ambient read-action (expand "…more" / open comments).
   * Rolling cooldown anchor so these decoys cluster like real reading instead of
   * firing every tick. Undefined until the first read-action of the session.
   */
  lastAmbientReadMs?: number;
  /**
   * Epoch ms of the last idle-like (a like slipped into the wait between
   * scheduled actions — Run/auto mode only; drain mode never idle-likes).
   * Rolling cooldown anchor so waiting-gap likes are paced, not fired every
   * tick. Undefined until the first idle-like of the session.
   */
  lastIdleLikeMs?: number;
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
   * Post URLs already commented on this session. Lyra can queue more than one
   * draft for the same post; posting two comments on one post reads as spam, so
   * a draft whose url is already here is dropped instead of posted.
   */
  actionedUrls?: string[];
  /** Browser cards deferred because the server had fewer discovery slots. */
  deferredObservations?: VisiblePost[];
  /** Last server capacity check / browser discovery read, paced to 90 seconds. */
  lastDiscoveryReadMs?: number;
  /**
   * Run mode. "scheduled" (default) spreads a target over a window; "drain"
   * posts every approved reply a short gap apart and returns to the feed
   * between them, where the gap's few planned likes (often none) + the ambient
   * browse play out.
   */
  mode?: "scheduled" | "drain";
  /**
   * Overnight POSTING curfew for THIS run. True only for the UNATTENDED,
   * set-and-forget paths — the "Full automatic" button and the autonomy
   * auto-start — where comments and DMs are held during the local night window
   * (see ../lib/curfew). Manual "Run" / "Drain all approvals" leave it undefined
   * (curfew off): the operator chose the hour. Likes + ambient browsing run
   * regardless of this flag. Undefined ⇒ off.
   */
  curfewEnabled?: boolean;
  /**
   * Drift state for the "occasionally skip the reply-coupled like" humaniser
   * (see ../lib/like-skip). Persisted so the 123-reply re-roll cadence and the
   * current skip rate survive across ticks. Undefined ⇒ not yet initialised.
   */
  likeSkip?: LikeSkipState;
  /**
   * How many times a drain has auto-extended itself to keep clearing the inbox.
   * A drain plans a FIXED number of comment slots (the queue size at start), but
   * the inbox can hold more than one batch (approvals capped at start, arriving
   * mid-run, or re-queued after a transient failure). When every slot is done and
   * pending comments remain, the drain appends a fresh batch instead of ending —
   * so one operator Drain clears the WHOLE inbox. Capped (MAX_DRAIN_ROUNDS) so a
   * queue that refills forever can't run unattended without end. Undefined ⇒ 0.
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
   * Notifications actor ("Auto notifications"). Deliberately a FLAG on an
   * ordinary unattended drain rather than a third `mode`: a sweep-only run
   * would harvest replies-to-us, hand them to Lyra, and then never post the
   * drafts — because the thing that posts approvals IS the drain it would have
   * superseded. As a flag, every existing `mode === "drain"` predicate keeps
   * working untouched and one click runs the whole loop. Undefined ⇒ plain drain.
   */
  notifications?: boolean;
  /**
   * Epoch ms of the last notifications sweep. The sweep replaces an ambient
   * browse in the tick's idle branch on a jittered ~10-20 min cadence.
   * Undefined ⇒ never swept (sweep on the first idle tick).
   */
  lastNotifSweepMs?: number;
  /**
   * Per-session drain temperament (pattern-weight mix, gap tempo, long-break
   * proneness) drawn once at startDrain and persisted so maybeExtendDrain plans
   * every round with the SAME mood — the tick rng is wall-clock-reseeded each
   * tick, so an unpersisted archetype would re-roll per round and the session
   * would have no coherent character. Optional: old persisted states and
   * scheduled runs load without it. See pickDrainArchetype in lib/scheduler.
   */
  drainStyle?: DrainArchetype;
  /**
   * The LinkedIn tab this run drives, pinned at startRun. Every tick reuses it
   * (via chooseActuatorTab) while it is still open, so the loop can't hop onto a
   * profile tab that merely sorts first — the operator's own /in/ tabs used to
   * hijack actuation because the tab was re-picked as tabs[0] every tick. Only
   * re-picked when the pinned tab has closed. Undefined until first assigned.
   */
  tabId?: number;
}

// One store owns this service worker's compound epoch and state operations.
// Session storage retains the run generation across worker restarts.
const sessionState = createSessionRunStateStore<RunState>(() => chrome.storage.session);
export async function saveState(s: RunState): Promise<void> { await sessionState.saveState(s); }
export async function loadState(): Promise<RunState | null> { return sessionState.loadState(); }
export async function clearState(): Promise<void> { await sessionState.clearState(); }
export async function currentEpoch(): Promise<number> { return sessionState.currentEpoch(); }
export async function bumpEpoch(): Promise<number> { return sessionState.bumpEpoch(); }

/** Save only if the state's epoch is still the current one. Returns whether it saved. */
export async function saveIfCurrent(s: RunState): Promise<boolean> {
  return sessionState.saveIfCurrent(s);
}

/** Reserve a startup generation before configuration or transport awaits. */
export async function claimEpoch(expectedEpoch?: number): Promise<number | null> {
  return sessionState.claimEpoch(expectedEpoch);
}
/** Serialize short metadata against cooperating starts and stops. */
export async function runIfCurrent(epoch: number, operation: () => Promise<void>): Promise<boolean> {
  return sessionState.runIfCurrent(epoch, operation);
}

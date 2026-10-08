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
 *                         only cost is an old server keeping the switch ON at
 *                         rest, the pre-`prior` behavior.)
 */
export function armedByManualEnable(prior: boolean | undefined): boolean {
  return prior === false;
}

// One store owns this service worker's compound epoch and state operations.
// Session storage retains the run generation across worker restarts.
const sessionState = createSessionRunStateStore<RunState>(() => chrome.storage.session);
export async function saveState(s: RunState): Promise<void> { await sessionState.saveState(s); }
export async function loadState(): Promise<RunState | null> { return sessionState.loadState(); }
export async function clearState(): Promise<void> { await sessionState.clearState(); }
export async function currentEpoch(): Promise<number> { return sessionState.currentEpoch(); }
export async function bumpEpoch(): Promise<number> { return sessionState.bumpEpoch(); }

/**
 * Pure guard: should endRun turn the master reply switch (reply_send_enabled)
 * back OFF? Only when BOTH hold:
 *   1. THIS run armed it (`armedSend` — a manual Run/Drain whose enable POST
 *      succeeded). Autonomous runs (checkAutonomy) deliberately never arm, and
 *      Reddit's actionable route has NO auto_send_enabled fallback, so an
 *      unconditional disable would overwrite the operator's standing dashboard
 *      toggle and silently starve every later lights-out run ("upvotes only,
 *      zero replies" with nothing surfaced).
 *   2. The ending run's epoch (`termEpoch`, stamped by endRun's own bump) is
 *      still current. A fresh Run/Drain that superseded this end has bumped
 *      past it and re-enabled sending for ITS run; disabling here would race
 *      that enable back OFF and empty the new run's queue (the "0/0 despite
 *      pending drafts" bug). Callers must run the check-then-disable inside the
 *      withSendSwitch serial queue so it can't interleave with an enable.
 */
export function shouldDisableSendOnRunEnd(opts: {
  armedSend: boolean | undefined;
  termEpoch: number;
  curEpoch: number;
}): boolean {
  return opts.armedSend === true && tickIsCurrent(opts.termEpoch, opts.curEpoch);
}

/** Save only if the state's epoch is still the current one. Returns whether it saved. */
export async function saveIfCurrent(s: RunState): Promise<boolean> {
  return sessionState.saveIfCurrent(s);
}

// ── Pending-arm marker (send-switch leak guard) ─────────────────────────────
// A manual Run/Drain arms the master reply switch (reply_send_enabled) BEFORE it
// fetches the queue and persists RunState. If anything between the landed arm
// and saveState throws (e.g. a transient api-vm 5xx on fetchQueue), no RunState
// carries armedSend, endRun never sees it, and autonomous runs never disarm by
// design — so the switch would stay ON indefinitely and the next lights-out run
// would post replies under a consent flag the operator never chose to leave
// standing. To make the arm fail-closed AT REST, the marker below is written to
// chrome.storage.local (survives SW + browser restarts) the moment an arm
// LANDS, and cleared only once the arm is accounted for: RunState persisted
// (endRun now owns the disarm) or the arm rolled back OFF after a failed start.
// While an UNACCOUNTED marker stands, checkAutonomy refuses to lights-out
// start and instead retries the disarm (see classifyPendingArm).

export interface PendingArm {
  /** The run epoch that armed the switch (bumped before the arm POST). */
  epoch: number;
  /** When the arm landed — distinguishes an in-flight start from a stale leak. */
  atMs: number;
}

const ARM_PENDING_KEY = "actuator.armPending";
/** A start (arm → fetch → plan → saveState) takes seconds; a marker older than
 * this can only be a leak from a failed start, never a start still in flight. */
export const ARM_PENDING_GRACE_MS = 2 * 60_000;

export async function setPendingArm(epoch: number, atMs: number): Promise<void> {
  await chrome.storage.local.set({ [ARM_PENDING_KEY]: { epoch, atMs } satisfies PendingArm });
}

export async function getPendingArm(): Promise<PendingArm | null> {
  const r = await chrome.storage.local.get(ARM_PENDING_KEY);
  const v = r[ARM_PENDING_KEY] as PendingArm | undefined;
  return v && typeof v.epoch === "number" && typeof v.atMs === "number" ? v : null;
}

/** Clear the marker ONLY if it still belongs to `epoch` — a newer manual start
 * may have overwritten it with ITS arm, which is not ours to erase. */
export async function clearPendingArm(epoch: number): Promise<void> {
  const cur = await getPendingArm();
  if (cur && cur.epoch === epoch) await chrome.storage.local.remove(ARM_PENDING_KEY);
}

/**
 * Pure classifier: what must checkAutonomy do about the pending-arm marker
 * before a lights-out start?
 *   "none"   → no marker; the switch state is fully accounted for — proceed.
 *   "wait"   → a FRESH marker (within the grace window): a manual start is
 *              likely still in flight between its arm and its saveState. Do NOT
 *              disarm under it (that would empty the manual run's queue — the
 *              "0/0 despite pending drafts" class) and do NOT lights-out start;
 *              re-evaluate next tick.
 *   "disarm" → a STALE marker: the arm leaked from a failed start. Best-effort
 *              disarm (then clear the marker); until the disarm SUCCEEDS the
 *              caller must keep refusing to auto-start — fail-closed.
 */
export function classifyPendingArm(
  arm: PendingArm | null,
  nowMs: number,
  graceMs: number = ARM_PENDING_GRACE_MS,
): "none" | "wait" | "disarm" {
  if (!arm) return "none";
  return nowMs - arm.atMs > graceMs ? "disarm" : "wait";
}

/**
 * Pure guard: must a manual Run/Drain INHERIT send-switch ownership from the
 * run it is superseding? Transition-aware arming (armedByManualEnable) alone
 * orphans the disarm on the double-press/restart path: standing toggle OFF →
 * Run A arms (prior=false, armedSend=true) → the operator presses Run/Drain
 * again mid-run. Run B's enable now sees prior=true (A already flipped the flag
 * ON), so B would not arm — and B's saveState overwrites A's RunState, the only
 * record that armedSend was true. Nobody disarms at run end and
 * reply_send_enabled stays ON at rest under a flag the operator never chose as
 * standing consent. So when the run being superseded is a LIVE run that armed
 * the switch itself (`status === "running"` with armedSend === true), or an
 * unaccounted pending-arm marker still stands (a manual start armed the switch
 * but its arm was never accounted for — mid-flight or leaked), the superseding
 * manual run inherits ownership: it sets its own armedSend=true (and stamps the
 * pending-arm marker for its epoch) even though its enable saw prior=true, so
 * its endRun (or the failed-start rollback) owns the disarm.
 *
 * Standing-consent protection is unaffected: with NO live armed run and no
 * pending marker, prior=true still means the operator's dashboard toggle — a
 * terminal superseded state (status !== "running", e.g. an ended run that
 * already disarmed or never armed) and a live UNARMED run (an autonomous run,
 * or a manual run started under the standing toggle: armedSend false/undefined)
 * never confer ownership, so that toggle is never disarmed.
 */
export function inheritsArmOnSupersede(opts: {
  supersededStatus: RunState["status"] | undefined;
  supersededArmedSend: boolean | undefined;
  pendingArm: PendingArm | null;
}): boolean {
  return (
    (opts.supersededStatus === "running" && opts.supersededArmedSend === true) ||
    opts.pendingArm != null
  );
}

// ── Reply hygiene ────────────────────────────────────────────────────────────

/** Reddit's per-comment character ceiling; replies are capped here before typing. */
export const MAX_REPLY_LEN = 10_000;

/**
 * Sanitize an approved reply for VERBATIM typing. The body is DATA — it is typed
 * literally, character for character, and never interpreted — so this only:
 *   1. normalizes CR / CRLF to LF,
 *   2. strips non-printable control characters (C0 except tab/newline, DEL, C1),
 *   3. caps the length at Reddit's comment limit.
 * It never rewrites wording. Legitimate literal whitespace (\n, \t) is preserved
 * so multi-paragraph drafts type as authored (CDP commits \n via Input.insertText,
 * which inserts a newline rather than firing an Enter key, so it can't submit).
 */
export function sanitizeReplyBody(raw: string): string {
  const lf = raw.replace(/\r\n?/g, "\n");
  // eslint-disable-next-line no-control-regex
  const printable = lf.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  return printable.slice(0, MAX_REPLY_LEN);
}

/**
 * Pure guard for the Reddit min-reply-spacing hard floor (default 240s / 4 min).
 * Returns true if a reply may fire now: either none has fired yet this session, or
 * at least `minSpacingMs` has elapsed since the last one. The caller defers (never
 * drops) when false.
 */
export function replySpacingOk(lastReplyMs: number | undefined, nowMs: number, minSpacingMs: number): boolean {
  if (lastReplyMs == null) return true;
  return nowMs - lastReplyMs >= minSpacingMs;
}

// ── Idle-upvote rate limiting ────────────────────────────────────────────────

/**
 * Count upvotes recorded within the rolling window ending at `now` (timestamps
 * strictly newer than `now - windowMs`). Pure — drives the ≤10/15-min hard cap.
 */
export function upvotesInWindow(upvoteAtMs: number[] | undefined, now: number, windowMs: number): number {
  if (!upvoteAtMs || upvoteAtMs.length === 0) return 0;
  const cutoff = now - windowMs;
  let n = 0;
  for (const t of upvoteAtMs) if (t > cutoff) n++;
  return n;
}

/**
 * Pure gate: may an idle-UPVOTE fire now? Mirrors the LinkedIn shouldIdleLike
 * shape but caps on a ROLLING WINDOW instead of a daily budget. Gated five ways
 * (in the order the code checks them):
 *  - quiet gap: never while `inQuietGap` — a drain gap the plan deliberately left
 *    long (a cooldown-band or long-break gap; scheduler.inQuietDrainGap). Firing an
 *    idle-upvote through it would erase the very "stepped away" pause the timing
 *    archetype drew; the ambient browse alone keeps the session looking alive.
 *  - enabled: the operator opt-in (cfg.upvotesEnabled !== false). Off ⇒ never.
 *  - curfew: never while `inCurfew` (the shared write-curfew gate, ../lib/curfew —
 *    dependency-injected so this stays pure; currently always false, disabled).
 *  - cap: at most `cap` (default 10) upvotes in the trailing `windowMs` (15 min).
 *  - pace: no sooner than `minGapMs` (~60s) after the most recent upvote OR
 *    upvote ATTEMPT (lastAttemptMs, optional) — anchoring on the attempt too
 *    means a failing locateUpvote scan retries on the min-gap cadence, not on
 *    every ~4s idle tick — so they never cluster.
 * UPVOTE-ONLY — this only ever authorizes an upvote; there is no downvote path.
 */
export function canUpvoteNow(args: {
  enabled: boolean;
  inCurfew: boolean;
  upvoteAtMs: number[] | undefined;
  now: number;
  cap: number;
  windowMs: number;
  minGapMs: number;
  lastAttemptMs?: number;
  inQuietGap?: boolean;
}): boolean {
  if (args.inQuietGap) return false;
  if (!args.enabled) return false;
  if (args.inCurfew) return false;
  if (upvotesInWindow(args.upvoteAtMs, args.now, args.windowMs) >= args.cap) return false;
  const lastHit = args.upvoteAtMs && args.upvoteAtMs.length > 0 ? Math.max(...args.upvoteAtMs) : -Infinity;
  const last = Math.max(lastHit, args.lastAttemptMs ?? -Infinity);
  return args.now - last > args.minGapMs;
}

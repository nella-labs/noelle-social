// Unattended (lights-out) auto-start decision.
//
// In autonomous mode the actuator starts one run per day inside an operating
// window, with no manual Run click. This module is the pure decision so it is
// deterministic and testable; the caller supplies the current local hour and a
// day key (no Date inside). The once-per-day guard is a persisted "last auto
// start day" the caller stamps after a successful start.

export interface AutoStartInput {
  /** Lights-out mode enabled. */
  autonomous: boolean;
  /** A run is already in progress. */
  runActive: boolean;
  /** Operator-local hour, 0..23. */
  localHour: number;
  /** Operating window start hour (inclusive). */
  startHour: number;
  /** Operating window end hour (exclusive). */
  endHour: number;
  /** Operator-local day key for "now", e.g. "2026-07-06". */
  todayKey: string;
  /** Day key of the last auto-start, or null if none yet. */
  lastAutoStartDay: string | null;
  /** Day key of the most recent challenge halt, or null. Optional (undefined ⇒ null ⇒ no backoff). */
  lastChallengeDay?: string | null;
  /** Days to suppress auto-start after a challenge halt. Optional (undefined ⇒ 0 ⇒ OFF). */
  challengeBackoffDays?: number;
}

/** Daytime operating window (no wrap; auto-start never runs overnight). */
export function withinOperatingHours(hour: number, start: number, end: number): boolean {
  return hour >= start && hour < end;
}

/** True when the actuator should auto-start a run right now. */
export function shouldAutoStart(i: AutoStartInput): boolean {
  if (!i.autonomous) return false;
  if (i.runActive) return false;
  if (i.todayKey === i.lastAutoStartDay) return false; // already started today
  // Post-challenge backoff (default OFF: challengeBackoffDays undefined/0). When
  // enabled, refuse to auto-start for N days after the last challenge halt. This
  // is a pure decision — both day keys are inputs; fail-closed on bad keys.
  if (challengeBackoffActive(i.lastChallengeDay ?? null, i.todayKey, i.challengeBackoffDays ?? 0)) return false;
  return withinOperatingHours(i.localHour, i.startHour, i.endHour);
}

// ── Challenge backoff / cooldown (pure, deterministic; no Date inside) ────────

export type ActuatorHealthStatus = "ok" | "warn" | "halt";

/** Calendar days b−a from two YYYY-MM-DD keys (UTC-anchored). NaN if unparseable. */
export function daysBetweenDayKeys(a: string, b: string): number {
  const pa = Date.parse(a + "T00:00:00Z");
  const pb = Date.parse(b + "T00:00:00Z");
  if (Number.isNaN(pa) || Number.isNaN(pb)) return NaN;
  return Math.round((pb - pa) / 86_400_000);
}

/**
 * Still inside the post-challenge cooldown window? Fail-closed (→ true = back
 * off / skip) on a null-becomes-caller-decision path: an unparseable or
 * backwards (clock-skew) day key returns true. Returns false when cooldown is
 * disabled (<=0) or no challenge has been recorded. Exclusive edge: a diff of
 * exactly cooldownDays clears the cooldown.
 */
export function withinChallengeCooldown(todayKey: string, lastChallengeDay: string | null, cooldownDays: number): boolean {
  if (!lastChallengeDay) return false;
  if (cooldownDays <= 0) return false;
  const diff = daysBetweenDayKeys(lastChallengeDay, todayKey);
  if (Number.isNaN(diff)) return true; // unparseable → fail-closed
  if (diff < 0) return true; // clock skew / future stamp → fail-closed
  return diff < cooldownDays; // exclusive: day == cooldownDays clears
}

/**
 * Post-challenge backoff gate for shouldAutoStart. Same semantics as
 * withinChallengeCooldown with the argument order flipped to (lastChallengeDay,
 * todayKey, backoffDays). Pure + fail-closed.
 */
export function challengeBackoffActive(lastChallengeDay: string | null, todayKey: string, backoffDays: number): boolean {
  return withinChallengeCooldown(todayKey, lastChallengeDay, backoffDays);
}

export interface SafetyGateInput {
  healthGate: boolean;
  healthStatus: ActuatorHealthStatus | null; // null = fetch failed / unknown
  challengeCooldownDays: number;
  todayKey: string;
  lastChallengeDay: string | null;
}

/**
 * Safe to auto-start given the post-challenge cooldown + server health. Purely a
 * function of its inputs. Fail-closed: an unknown health status (fetch failed →
 * null) with the gate on returns false; any non-'ok' status returns false.
 */
export function passesAutoStartSafety(i: SafetyGateInput): boolean {
  if (withinChallengeCooldown(i.todayKey, i.lastChallengeDay, i.challengeCooldownDays)) return false;
  if (i.healthGate && i.healthStatus !== "ok") return false; // 'warn' | 'halt' | null → skip
  return true;
}

// ── Durable drain standing intent ("leave it running") ───────────────────────

/**
 * Pure decision: should the tick RESUME a standing drain right now?
 *
 * BOTH panel drain buttons — "Drain all approvals" and "Full automatic" — are a
 * durable, operator-set standing intent (a record in chrome.storage.local, set on
 * the click, cleared ONLY by STOP), not a live run. They differ by exactly one
 * thing: Full automatic carries an overnight posting-curfew, Drain does not.
 * Everything else is identical, including this: the intent exists so the drain
 * survives everything that wipes the in-memory run — a self-reload onto a new
 * build (chrome.runtime.reload clears chrome.storage.session), a service-worker
 * death, a browser restart, a closed tab. Whenever the intent is set and nothing
 * is running, the tick restarts the drain — so both buttons mean "runs until I
 * say STOP", not "until the next deploy". `safe` folds in the SAME post-challenge
 * cooldown + health gate the autonomy auto-start uses (passesAutoStartSafety): a
 * freshly-challenged account holds off and resumes only once clean, no re-click,
 * no hammering.
 *
 * Independent of the lights-out `autonomous` switch on purpose: a drain button is
 * the operator's explicit one-click consent, and must work without them also
 * configuring lights-out.
 */
export function shouldResumeDrain(i: {
  /** The durable drain intent is set (operator clicked Drain/Full-auto, no STOP since). */
  intentSet: boolean;
  /** A run is already live — never start a second, overlapping one. */
  runActive: boolean;
  /** passesAutoStartSafety verdict (health ok + not in post-challenge cooldown). */
  safe: boolean;
}): boolean {
  return i.intentSet && !i.runActive && i.safe;
}

// ── Auto-drain (lights-out inbox clearing) ───────────────────────────────────

export interface AutoDrainInput {
  /** Lights-out mode enabled (master autonomy switch). */
  autonomous: boolean;
  /** Auto-drain opt-in: start a drain whenever approved replies are waiting. */
  autoDrain: boolean;
  /** A run is already in progress. */
  runActive: boolean;
  /** Operator-local hour, 0..23. */
  localHour: number;
  /** Operating window start hour (inclusive). */
  startHour: number;
  /** Operating window end hour (exclusive). */
  endHour: number;
  /** Approved comments the server is currently willing to serve. */
  pendingComments: number;
  /** ms timestamp of the last auto-drain start, or null if none yet. */
  lastAutoDrainMs: number | null;
  /** Now, ms. */
  nowMs: number;
  /** Minimum minutes between auto-drain starts (re-arm cooldown). */
  minGapMinutes: number;
  /** Operator-local day key for "now". */
  todayKey: string;
  /** Day key of the last manual STOP, or null. A STOP silences autonomy for the day. */
  stopDay?: string | null;
}

/**
 * True when the autonomy tick should start a drain right now. Unlike the daily
 * auto-start this is NOT once-per-day — it fires whenever the server serves
 * approved comments and nothing is running, so an approval made at 3pm goes out
 * at 3pm, not tomorrow. Supply is what `/api/actionable-linkedin` returns, so
 * every server-side withhold gate (master switch, challenge breaker, working
 * hours, caps) starves this loop before it can act. The re-arm cooldown bounds
 * the pathological case of a run that keeps failing with items still queued;
 * clock skew on the stamp fails closed. The caller must ALSO run
 * passesAutoStartSafety — this function only decides supply + scheduling.
 */
export function shouldAutoDrain(i: AutoDrainInput): boolean {
  if (!i.autonomous || !i.autoDrain) return false;
  if (i.runActive) return false;
  if (i.pendingComments <= 0) return false;
  if (i.stopDay != null && i.stopDay === i.todayKey) return false; // operator STOP wins for the day
  if (!withinOperatingHours(i.localHour, i.startHour, i.endHour)) return false;
  if (i.lastAutoDrainMs != null) {
    const gapMs = i.nowMs - i.lastAutoDrainMs;
    if (Number.isNaN(gapMs) || gapMs < 0) return false; // skew/garbage stamp → fail-closed
    if (gapMs < i.minGapMinutes * 60_000) return false;
  }
  return true;
}

// ── Stalled-run recovery ─────────────────────────────────────────────────────

export interface StalledRunInput {
  /** Lights-out mode enabled (master autonomy switch). */
  autonomous: boolean;
  /** Auto-drain opt-in — recovery is a form of auto-drain, gated the same way. */
  autoDrain: boolean;
  /** A run is currently live (recovery only ever supersedes a running run). */
  runActive: boolean;
  /** ms since the last successful post: now − (lastProgressMs ?? startMs). */
  msSinceProgress: number;
  /** ms since the run started: now − startMs, used to clear the warm-up window. */
  msSinceStart: number;
  /** Warm-up write-suppression window; a run still inside it is not "stalled". */
  warmupSuppressMs: number;
  /** No-progress threshold that marks a run as wedged. */
  stallThresholdMs: number;
  /** Approved drafts loaded and waiting to post (commentPool length). */
  loadedDrafts: number;
  /** Unexecuted comment slots already overdue (atMs ≤ now). */
  dueCommentSlots: number;
  /** Operator-local hour, 0..23. */
  localHour: number;
  /** Operating window start hour (inclusive). */
  startHour: number;
  /** Operating window end hour (exclusive). */
  endHour: number;
  /** ms of the last auto-drain start (SHARED with shouldAutoDrain), or null. */
  lastAutoDrainMs: number | null;
  /** Now, ms. */
  nowMs: number;
  /** Minimum minutes between drain starts (the SHARED re-arm cooldown). */
  minGapMinutes: number;
  /** Operator-local day key for "now". */
  todayKey: string;
  /** Day key of the last manual STOP, or null. */
  stopDay?: string | null;
}

/**
 * True when the autonomy tick should recover a WEDGED run by superseding it with
 * a fresh drain. This fills the gap shouldAutoDrain leaves: its runActive gate
 * skips whenever a run is live, so a run that is "running" but making no progress
 * (a frozen tick loop, a tab that wandered off, a wall of comment-failed skips)
 * would otherwise pin the actor with approvals piling up and never recover.
 *
 * Fires ONLY on a provably stalled run — drafts loaded AND comment slots overdue
 * AND no successful post for stallThresholdMs, past warm-up — never on a run that
 * is merely idle-waiting for supply (nothing loaded) or correctly paced between
 * actions (nothing overdue). It reuses every auto-drain gate and CRUCIALLY shares
 * the re-arm cooldown (lastAutoDrainMs / minGapMinutes) with shouldAutoDrain: at
 * most one drain start — auto OR recovery — per re-arm window per lane, the
 * load-bearing bound on a false-positive spam. The caller must ALSO run
 * passesAutoStartSafety (health + post-challenge cooldown) and must never arm
 * sending on this path. Fail-closed on clock skew.
 */
export function shouldRecoverStalledRun(i: StalledRunInput): boolean {
  if (!i.autonomous || !i.autoDrain) return false;
  if (!i.runActive) return false;                           // only a live run can be wedged
  if (i.loadedDrafts <= 0) return false;                    // nothing loaded → supply-gated idle, not stuck
  if (i.dueCommentSlots <= 0) return false;                 // nothing overdue → correctly paced, not stuck
  if (i.msSinceStart <= i.warmupSuppressMs) return false;   // still warming up → not stalled
  if (i.msSinceProgress < i.stallThresholdMs) return false; // posted recently → healthy
  if (i.stopDay != null && i.stopDay === i.todayKey) return false; // operator STOP wins for the day
  if (!withinOperatingHours(i.localHour, i.startHour, i.endHour)) return false;
  if (i.lastAutoDrainMs != null) {
    const gapMs = i.nowMs - i.lastAutoDrainMs;
    if (Number.isNaN(gapMs) || gapMs < 0) return false;     // skew/garbage stamp → fail-closed
    if (gapMs < i.minGapMinutes * 60_000) return false;     // SHARED re-arm cooldown
  }
  return true;
}

// ── Two-tick stall confirmation ──────────────────────────────────────────────

/** A persisted stall observation: the run + its progress marker when first seen stalled. */
export interface StallProbe {
  sid: string;       // RunState.sessionId the observation belongs to
  progressMs: number; // lastProgressMs ?? startMs at first observation
}

export interface StallConfirmInput {
  /** shouldRecoverStalledRun's verdict this tick. */
  stalledNow: boolean;
  /** Current run's sessionId. */
  sessionId: string;
  /** Current progress marker (lastProgressMs ?? startMs). */
  progressMs: number;
  /** The persisted prior observation, or null if none. */
  probe: StallProbe | null;
}

export type StallConfirmResult = "recover" | "observe" | "clear";

/**
 * Two-tick confirmation guard on top of shouldRecoverStalledRun. A single
 * snapshot can't distinguish a HEALTHY run momentarily past the no-progress
 * threshold (a scheduled run's legitimately large inter-comment gap, or the
 * ~15-60s window while a post is mid-flight and the slot still reads overdue)
 * from a genuinely wedged one. So recovery requires the run to look stalled on
 * TWO consecutive autonomy ticks with the SAME progress marker: a healthy run
 * posts within ~60s, so by the next tick (~5 min later) its progressMs has
 * advanced and it never confirms; a real wedge makes no progress and confirms.
 *   - "clear"   → not stalled now; drop any probe.
 *   - "recover" → stalled now AND the probe is this run with unchanged progress → act.
 *   - "observe" → first stalled sighting (or progress advanced since) → record + wait.
 */
export function confirmStall(i: StallConfirmInput): StallConfirmResult {
  if (!i.stalledNow) return "clear";
  if (i.probe && i.probe.sid === i.sessionId && i.probe.progressMs === i.progressMs) return "recover";
  return "observe";
}

// ── Self-reload on new build ─────────────────────────────────────────────────

export interface SelfReloadInput {
  /** A run is in progress — never yank the code out from under it. */
  runActive: boolean;
  /**
   * The live run is safe to interrupt AND will come back on its own: it has
   * nothing loaded to send (both pools empty, so no work is lost) and autonomy is
   * armed to restart it. Without this, persistent drains — which never end by
   * design — would pin `runActive` true forever and the extension could NEVER
   * self-update onto a new build. Undefined ⇒ false (old fail-safe behaviour).
   */
  runResumable?: boolean;
  /** Stamp compiled into this bundle, or null if the define is missing. */
  embeddedStamp: string | null;
  /** Stamp api-vm read from the on-disk build, or null (missing/unreadable). */
  servedStamp: string | null;
  /** Last stamp a reload was already attempted for (persisted). */
  lastAttemptedStamp: string | null;
}

/**
 * True when the extension should chrome.runtime.reload() to pick up a newer
 * on-disk build. Fail-closed on unknowns (either stamp null → no reload), and
 * one attempt per served stamp: if the reload didn't change the embedded stamp
 * (a stale disk copy that hasn't synced yet), it must not loop every alarm tick.
 */
export function shouldSelfReload(i: SelfReloadInput): boolean {
  // A busy run is never interrupted. A run that is merely PERSISTENT-and-idle is,
  // because a persistent drain never ends: leaving the old guard would mean the
  // extension stays on a stale build for as long as the drain is running.
  if (i.runActive && !i.runResumable) return false;
  if (i.embeddedStamp == null || i.servedStamp == null) return false;
  if (i.servedStamp === i.embeddedStamp) return false; // already running the on-disk build
  if (i.servedStamp === i.lastAttemptedStamp) return false; // one attempt per stamp
  return true;
}

/** Operator-local YYYY-MM-DD key, used to gate one auto-start per day. */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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
  /** Approved replies the server is currently willing to serve. */
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
 * approved replies and nothing is running, so an approval made at 3pm goes out
 * at 3pm, not tomorrow. Supply is what `/api/actionable-x` returns, so every
 * server-side withhold gate (master switch, challenge breaker, caps) starves
 * this loop before it can act. The re-arm cooldown bounds the pathological case
 * of a run that keeps failing with items still queued; clock skew on the stamp
 * fails closed. The caller must ALSO run passesAutoStartSafety — this function
 * only decides supply + scheduling.
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

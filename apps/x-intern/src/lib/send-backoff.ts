// Pure, deterministic helpers for the X send worker's 429 backoff (nowMs passed
// in, no Date.now inside — unit-testable per NON-NEGOTIABLE rule 4). Mirrors the
// in-memory ladder send.ts has always used (15 → 30 → 60 → 120-min cap); the
// persist-cooldown feature (X_PERSIST_SEND_COOLDOWN) folds a DB-stored cooldown
// into isInCooldown so a deploy-restart can't resume posting into a throttled
// account. See docs/x-account-safety.md §8.

const LADDER_BASE_MIN = 15;
const LADDER_CAP_MIN = 120; // 429 escalation cap; policy restrictions can set a longer deadline.

export interface Backoff {
  streak: number;
  mins: number;
  cooldownUntilMs: number;
}

/** Next streak+cooldown after a 429. Mirrors send.ts today: 15,30,60,120(cap). */
export function escalateBackoff(prevStreak: number, nowMs: number): Backoff {
  const streak = prevStreak + 1;
  const mins = Math.min(LADDER_BASE_MIN * 2 ** (streak - 1), LADDER_CAP_MIN);
  return { streak, mins, cooldownUntilMs: nowMs + mins * 60_000 };
}

/** Honor the later explicit deadline, including the worker's six-hour policy hold. */
export function isInCooldown(
  persistedUntilMs: number | null,
  inMemoryUntilMs: number | undefined,
  nowMs: number,
): boolean {
  const until = Math.max(inMemoryUntilMs ?? 0, persistedUntilMs ?? 0);
  return until > 0 && nowMs < until;
}

/**
 * Should a clean tick clear the 429 backoff streak+cooldown? Only when
 * something actually SENT, nothing was rate-limited this tick, AND no systemic
 * reply-restriction 403 set the policy cooldown this same tick. That last guard
 * is the subtle one: a single successful send can co-occur with a systemic 403
 * run before the batch breaks — clearing then would wipe the just-set
 * POLICY_403_COOLDOWN and resume posting straight into the account/app reply
 * block. Pure so it's unit-testable (NON-NEGOTIABLE rule 4).
 */
export function shouldClearSendBackoff(a: {
  sent: boolean;
  rateLimited: boolean;
  systemicForbidden: boolean;
}): boolean {
  return a.sent && !a.rateLimited && !a.systemicForbidden;
}

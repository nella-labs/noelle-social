import { describe, it, expect } from "vitest";
import {
  dueActionIndex, withinWindow, tickIsCurrent,
  sanitizeReplyBody, replySpacingOk, MAX_REPLY_LEN,
  canUpvoteNow, upvotesInWindow, shouldDisableSendOnRunEnd, armedByManualEnable,
  classifyPendingArm, ARM_PENDING_GRACE_MS, inheritsArmOnSupersede,
} from "../src/background/state.js";
import type { SlotAction } from "../src/background/state.js";

const acts: SlotAction[] = [
  { kind: "like", atMs: 1000, executed: false },
  { kind: "comment", atMs: 2000, executed: false },
  { kind: "like", atMs: 1500, executed: true },  // already executed → ignored
  { kind: "dm", atMs: 1800, executed: false },
];

describe("background state helpers", () => {
  it("returns the earliest unexecuted action whose time has passed", () => {
    // at 2500: candidates atMs<=2500 & !executed → like@1000, comment@2000, dm@1800 → earliest = like@1000 (idx 0)
    expect(dueActionIndex(acts, 2500)).toBe(0);
  });

  it("ignores executed slots and respects not-yet-due", () => {
    // at 1200: only like@1000 is due+unexecuted
    expect(dueActionIndex(acts, 1200)).toBe(0);
    // at 500: nothing due
    expect(dueActionIndex(acts, 500)).toBe(-1);
  });

  it("returns -1 when all due slots are executed", () => {
    const allDone: SlotAction[] = [{ kind: "like", atMs: 1000, executed: true }];
    expect(dueActionIndex(allDone, 5000)).toBe(-1);
  });

  it("withinWindow respects the window end", () => {
    expect(withinWindow(0, 1, 30 * 60_000)).toBe(true);
    expect(withinWindow(0, 1, 61 * 60_000)).toBe(false);
  });
});

describe("tickIsCurrent (stop/supersede guard)", () => {
  it("is true only when the loaded epoch matches the current epoch", () => {
    expect(tickIsCurrent(3, 3)).toBe(true);
    expect(tickIsCurrent(2, 3)).toBe(false); // superseded by a newer run / STOP
    expect(tickIsCurrent(4, 3)).toBe(false); // impossible-but-safe: newer than current
  });

  it("treats pre-upgrade state (undefined epoch) as epoch 0", () => {
    expect(tickIsCurrent(undefined, 0)).toBe(true);
    expect(tickIsCurrent(undefined, 1)).toBe(false); // a run has since started → stale
  });
});

describe("sanitizeReplyBody (verbatim reply hygiene)", () => {
  it("preserves literal text including newlines and tabs", () => {
    expect(sanitizeReplyBody("hello\nworld\tok")).toBe("hello\nworld\tok");
  });
  it("normalizes CRLF / CR to LF", () => {
    expect(sanitizeReplyBody("a\r\nb\rc")).toBe("a\nb\nc");
  });
  it("strips non-printable control chars (C0 except tab/newline, DEL, C1)", () => {
    expect(sanitizeReplyBody("a\u0000b\u0007c\u001Fd\u007Fe\u009Ff")).toBe("abcdef");
  });
  it("caps length at MAX_REPLY_LEN", () => {
    expect(sanitizeReplyBody("x".repeat(MAX_REPLY_LEN + 500)).length).toBe(MAX_REPLY_LEN);
  });
  it("never rewrites wording (punctuation, em-dash, emoji, links pass through)", () => {
    const body = "Great point — I use it daily! 🚀 see https://example.com for the writeup";
    expect(sanitizeReplyBody(body)).toBe(body);
  });
});

describe("replySpacingOk (min-spacing hard floor, parameterized)", () => {
  it("allows the first reply of a session (no prior)", () => {
    expect(replySpacingOk(undefined, 1_000_000, 600_000)).toBe(true);
  });
  it("blocks a reply that would land too soon after the last one", () => {
    expect(replySpacingOk(1_000_000, 1_000_000 + 599_000, 600_000)).toBe(false);
  });
  it("allows a reply once the floor has elapsed", () => {
    expect(replySpacingOk(1_000_000, 1_000_000 + 600_000, 600_000)).toBe(true);
  });
  it("enforces the new Reddit 240s (4 min) floor", () => {
    expect(replySpacingOk(1_000_000, 1_000_000 + 239_000, 240_000)).toBe(false);
    expect(replySpacingOk(1_000_000, 1_000_000 + 240_000, 240_000)).toBe(true);
  });
});

describe("upvote rate limit — UPVOTE-ONLY, ≤10 per rolling 15 min, ~60s min-gap", () => {
  const WIN = 15 * 60_000; // rolling 15-min window
  const GAP = 60_000;      // ~60s min-gap
  const CAP = 10;

  it("upvotesInWindow counts only timestamps inside the trailing window", () => {
    const now = 100 * 60_000;
    const ts = [now - 20 * 60_000, now - 10 * 60_000, now - 60_000, now]; // the 20-min-old one is out
    expect(upvotesInWindow(ts, now, WIN)).toBe(3);
    expect(upvotesInWindow(undefined, now, WIN)).toBe(0);
    expect(upvotesInWindow([], now, WIN)).toBe(0);
  });

  it("allows the first upvote of a session (no history)", () => {
    expect(canUpvoteNow({ enabled: true, inCurfew: false, upvoteAtMs: [], now: 1_000_000, cap: CAP, windowMs: WIN, minGapMs: GAP })).toBe(true);
  });

  it("BLOCKS the 11th upvote inside a 15-min window (hard cap of 10)", () => {
    const now = 1_000_000;
    // 10 upvotes 80s..800s ago — all inside the window, most-recent 80s ago (min-gap ok)
    const ts = Array.from({ length: 10 }, (_, i) => now - (i + 1) * 80_000);
    expect(upvotesInWindow(ts, now, WIN)).toBe(10);
    expect(canUpvoteNow({ enabled: true, inCurfew: false, upvoteAtMs: ts, now, cap: CAP, windowMs: WIN, minGapMs: GAP })).toBe(false);
  });

  it("ALLOWS again once the window slides so fewer than 10 remain", () => {
    const now = 1_000_000;
    const old = Array.from({ length: 4 }, (_, i) => now - (16 + i) * 60_000); // 16–19 min ago → out
    const inWin = Array.from({ length: 6 }, (_, i) => now - (i + 1) * 80_000); // 6 in-window, most-recent 80s ago
    const ts = [...old, ...inWin];
    expect(upvotesInWindow(ts, now, WIN)).toBe(6);
    expect(canUpvoteNow({ enabled: true, inCurfew: false, upvoteAtMs: ts, now, cap: CAP, windowMs: WIN, minGapMs: GAP })).toBe(true);
  });

  it("ENFORCES the ~60s min-gap between upvotes (never cluster)", () => {
    const now = 1_000_000;
    expect(canUpvoteNow({ enabled: true, inCurfew: false, upvoteAtMs: [now - 30_000], now, cap: CAP, windowMs: WIN, minGapMs: GAP })).toBe(false); // 30s < 60s
    expect(canUpvoteNow({ enabled: true, inCurfew: false, upvoteAtMs: [now - 61_000], now, cap: CAP, windowMs: WIN, minGapMs: GAP })).toBe(true);  // 61s > 60s
  });

  it("hard-disables when the operator opted out (enabled=false), regardless of budget", () => {
    expect(canUpvoteNow({ enabled: false, inCurfew: false, upvoteAtMs: [], now: 1_000_000, cap: CAP, windowMs: WIN, minGapMs: GAP })).toBe(false);
  });

  it("never upvotes while the write-curfew gate is on (dependency-injected)", () => {
    expect(canUpvoteNow({ enabled: true, inCurfew: true, upvoteAtMs: [], now: 1_000_000, cap: CAP, windowMs: WIN, minGapMs: GAP })).toBe(false);
    expect(canUpvoteNow({ enabled: true, inCurfew: false, upvoteAtMs: [], now: 1_000_000, cap: CAP, windowMs: WIN, minGapMs: GAP })).toBe(true);
  });

  it("paces off the last ATTEMPT too — a failed scan can't retry every tick", () => {
    const now = 1_000_000;
    // No successful upvote yet, but an attempt fired 30s ago → still cooling down.
    expect(canUpvoteNow({ enabled: true, inCurfew: false, upvoteAtMs: [], now, cap: CAP, windowMs: WIN, minGapMs: GAP, lastAttemptMs: now - 30_000 })).toBe(false);
    // Once the min-gap has elapsed since the attempt, it may try again.
    expect(canUpvoteNow({ enabled: true, inCurfew: false, upvoteAtMs: [], now, cap: CAP, windowMs: WIN, minGapMs: GAP, lastAttemptMs: now - 61_000 })).toBe(true);
    // The most recent anchor wins: old success + fresh attempt still blocks.
    expect(canUpvoteNow({ enabled: true, inCurfew: false, upvoteAtMs: [now - 120_000], now, cap: CAP, windowMs: WIN, minGapMs: GAP, lastAttemptMs: now - 10_000 })).toBe(false);
  });

  it("SUPPRESSES an idle-upvote inside a quiet drain gap (inQuietGap), even when budget + pace allow", () => {
    const now = 1_000_000;
    // No history, not in curfew, min-gap satisfied → normally ALLOWED …
    expect(canUpvoteNow({ enabled: true, inCurfew: false, upvoteAtMs: [], now, cap: CAP, windowMs: WIN, minGapMs: GAP })).toBe(true);
    // … but a quiet cooldown/long-break gap hard-blocks it FIRST (mirrors the
    // LinkedIn shouldIdleLike inQuietGap gate): idle-upvoting through the pause the
    // timing archetype drew would erase it.
    expect(canUpvoteNow({ enabled: true, inCurfew: false, upvoteAtMs: [], now, cap: CAP, windowMs: WIN, minGapMs: GAP, inQuietGap: true })).toBe(false);
    // inQuietGap:false is the pass-through (the normal, non-cooldown case).
    expect(canUpvoteNow({ enabled: true, inCurfew: false, upvoteAtMs: [], now, cap: CAP, windowMs: WIN, minGapMs: GAP, inQuietGap: false })).toBe(true);
  });
});

// endRun's reply_send_enabled disarm gate. Two regressions pinned here:
//   1. LIGHTS-OUT AUTONOMY: autonomous runs (checkAutonomy) never arm the
//      switch — the documented workflow is the operator setting
//      reply_send_enabled=true from the dashboard, and unlike LinkedIn,
//      GET /api/actionable-reddit has NO auto_send_enabled fallback. So when an
//      unarmed run ends (window expiry included), the disable MUST be skipped or
//      every later autonomous run silently fetches an empty queue.
//   2. SEND-SWITCH RACE: run A's window expires (endRun) concurrently with the
//      operator clicking Run. The new run bumps the epoch past endRun's `term`
//      and enables sending for itself; a superseded endRun must SKIP its
//      disable, or the new manual run polls with the flag OFF and posts nothing
//      (the "0/0 despite pending drafts" bug).
describe("shouldDisableSendOnRunEnd", () => {
  it("disarms a manual run that armed the switch and is still current", () => {
    expect(shouldDisableSendOnRunEnd({ armedSend: true, termEpoch: 5, curEpoch: 5 })).toBe(true);
  });

  it("NEVER disarms an autonomous (unarmed) run — the operator's standing dashboard toggle survives window expiry", () => {
    // checkAutonomy → startRun without the manual flag → armedSend undefined.
    expect(shouldDisableSendOnRunEnd({ armedSend: undefined, termEpoch: 5, curEpoch: 5 })).toBe(false);
    // A manual run whose arm POST FAILED (older api-vm) also never armed:
    // the flag is whatever the operator set — not ours to flip OFF.
    expect(shouldDisableSendOnRunEnd({ armedSend: false, termEpoch: 5, curEpoch: 5 })).toBe(false);
  });

  it("skips the disable when superseded by a fresh run's epoch bump (the '0/0 despite pending drafts' race)", () => {
    // endRun bumped to term=5; a concurrent manual Run bumped to 6 and enabled
    // sending for ITS run → the stale run-end must leave the switch alone.
    expect(shouldDisableSendOnRunEnd({ armedSend: true, termEpoch: 5, curEpoch: 6 })).toBe(false);
  });
});

// The CONSENT-FLAG OVERLOAD (round-4 review): Reddit collapses per-run consent
// and STANDING lights-out consent onto the single reply_send_enabled column
// (GET /api/actionable-reddit has no auto_send_enabled fallback). armedSend
// therefore must mean "this run performed the OFF→ON transition", not merely
// "the enable POST landed": a manual Run/Drain clicked while the operator's
// standing dashboard toggle is ON must NOT disarm that toggle at run end —
// doing so silently revokes the documented lights-out consent and every later
// autonomous run serves an empty queue (upvotes/ambient only, zero replies).
// armedByManualEnable maps the server-reported `prior` value onto that intent.
describe("armedByManualEnable (transition-aware arming)", () => {
  it("standing consent ON (prior=true) + manual run → NOT armed → run end does NOT disarm", () => {
    // The enable was a no-op against the operator's standing toggle: the switch
    // is not this run's to flip OFF. This is the reviewer's clobber scenario.
    expect(armedByManualEnable(true)).toBe(false);
    expect(
      shouldDisableSendOnRunEnd({ armedSend: armedByManualEnable(true), termEpoch: 5, curEpoch: 5 }),
    ).toBe(false);
  });

  it("switch OFF (prior=false) + manual run arms → run end disarms (fail-closed at rest)", () => {
    // This run turned the flag ON itself, so endRun owns turning it back OFF.
    expect(armedByManualEnable(false)).toBe(true);
    expect(
      shouldDisableSendOnRunEnd({ armedSend: armedByManualEnable(false), termEpoch: 5, curEpoch: 5 }),
    ).toBe(true);
  });

  it("old server (prior missing) → NEVER disarms — fail-safe toward standing consent", () => {
    // An older api-vm doesn't report prior; the flag MIGHT be the operator's
    // standing consent, so it is never ours to flip OFF. (Posting stays
    // fail-closed either way — this only governs the end-of-run disarm.)
    expect(armedByManualEnable(undefined)).toBe(false);
    expect(
      shouldDisableSendOnRunEnd({ armedSend: armedByManualEnable(undefined), termEpoch: 5, curEpoch: 5 }),
    ).toBe(false);
  });
});

// The failed-start ARM LEAK (round-3 review): a manual Run/Drain arms
// reply_send_enabled, then fetchQueue throws (transient api-vm 5xx) before any
// RunState is persisted. No RunState → endRun never sees armedSend, and
// autonomous runs never disarm by design — so without the pending-arm marker
// the switch would stay ON indefinitely and the next 9–21 checkAutonomy window
// would post replies lights-out under a consent flag the operator never chose
// to leave standing. classifyPendingArm is what checkAutonomy consults before
// ANY lights-out start.
describe("classifyPendingArm (failed-start send-switch leak guard)", () => {
  const now = 10_000_000;

  it("no marker → 'none' (every arm is accounted for; lights-out start may proceed)", () => {
    expect(classifyPendingArm(null, now)).toBe("none");
  });

  it("FRESH marker → 'wait': a manual start is in flight between its arm and its saveState — never disarm under it, never auto-start over it", () => {
    // Disarming here would empty the manual run's queue (the "0/0 despite
    // pending drafts" class); starting here would double-run. Both must wait.
    expect(classifyPendingArm({ epoch: 7, atMs: now - 5_000 }, now)).toBe("wait");
    // Boundary: exactly at the grace edge is still "wait" (fail toward caution).
    expect(classifyPendingArm({ epoch: 7, atMs: now - ARM_PENDING_GRACE_MS }, now)).toBe("wait");
  });

  it("STALE marker → 'disarm': the exact reviewer race — arm landed, fetchQueue 5xx'd, no RunState persisted", () => {
    // A start takes seconds; a marker older than the grace window can only be a
    // leak. checkAutonomy must retry the disarm and keep refusing to auto-start
    // until the switch is confirmed OFF (fail-closed at rest).
    expect(classifyPendingArm({ epoch: 7, atMs: now - ARM_PENDING_GRACE_MS - 1 }, now)).toBe("disarm");
    expect(classifyPendingArm({ epoch: 7, atMs: now - 3600_000 }, now)).toBe("disarm");
  });

  it("honors a custom grace window", () => {
    expect(classifyPendingArm({ epoch: 1, atMs: now - 2_000 }, now, 1_000)).toBe("disarm");
    expect(classifyPendingArm({ epoch: 1, atMs: now - 500 }, now, 1_000)).toBe("wait");
  });
});

// The SUPERSESSION ORPHANED-ARM leak (round-5 review): transition-aware arming
// (armedByManualEnable) breaks the disarm hand-off when a manual Run/Drain
// supersedes a LIVE manual-armed run. Standing toggle OFF → Run A arms
// (prior=false, armedSend=true) → the operator presses Run/Drain again mid-run
// (the double-press/restart path startRun explicitly supports). Run B's enable
// sees prior=true (A's own flip, NOT standing consent) so B would not arm, B's
// saveState overwrites A's RunState (the only record armedSend was true), B's
// endRun sees armedSend=false → nobody disarms → reply_send_enabled stays ON
// at rest and the next lights-out run posts replies under a flag the operator
// never chose as standing consent. inheritsArmOnSupersede is the hand-off: the
// superseding manual run inherits the arm from a live armed predecessor (or an
// unaccounted pending-arm marker) so its endRun / failed-start rollback owns
// the disarm — while a manual run with NO live armed predecessor still treats
// prior=true as the operator's standing dashboard toggle and never disarms it.
describe("inheritsArmOnSupersede (double-press/restart disarm hand-off)", () => {
  it("REGRESSION (a): OFF → Run A arms → Run/Drain B supersedes mid-run → B inherits the arm → B's endRun disarms (switch OFF at rest)", () => {
    // B's own enable saw prior=true (A flipped it), so transition-aware arming
    // alone says NOT armed …
    expect(armedByManualEnable(true)).toBe(false);
    // … but A is a live run that armed the switch itself, so B inherits.
    const armedSend =
      armedByManualEnable(true) ||
      inheritsArmOnSupersede({ supersededStatus: "running", supersededArmedSend: true, pendingArm: null });
    expect(armedSend).toBe(true);
    // B's endRun (still current) therefore owns and performs the disarm.
    expect(shouldDisableSendOnRunEnd({ armedSend, termEpoch: 6, curEpoch: 6 })).toBe(true);
  });

  it("REGRESSION (b): standing-toggle-ON manual run with NO live armed predecessor never arms → never disarms the operator's toggle", () => {
    // No prior state at all (first run of the session) …
    expect(
      inheritsArmOnSupersede({ supersededStatus: undefined, supersededArmedSend: undefined, pendingArm: null }),
    ).toBe(false);
    // … or a terminal predecessor (already ended; its arm, if any, was already
    // disarmed by its own endRun) …
    expect(
      inheritsArmOnSupersede({ supersededStatus: "stopped", supersededArmedSend: true, pendingArm: null }),
    ).toBe(false);
    expect(
      inheritsArmOnSupersede({ supersededStatus: "idle", supersededArmedSend: true, pendingArm: null }),
    ).toBe(false);
    // … or a LIVE but UNARMED predecessor (an autonomous run, or a manual run
    // started under the standing toggle) — none confer ownership:
    expect(
      inheritsArmOnSupersede({ supersededStatus: "running", supersededArmedSend: false, pendingArm: null }),
    ).toBe(false);
    expect(
      inheritsArmOnSupersede({ supersededStatus: "running", supersededArmedSend: undefined, pendingArm: null }),
    ).toBe(false);
    // So the run's armedSend stays false (prior=true = standing consent) and
    // run end leaves the dashboard toggle alone.
    const armedSend = armedByManualEnable(true) || false;
    expect(shouldDisableSendOnRunEnd({ armedSend, termEpoch: 6, curEpoch: 6 })).toBe(false);
  });

  it("inherits from an unaccounted pending-arm marker (predecessor armed but its arm was never accounted for)", () => {
    // A manual start armed the switch, stamped the marker, and its RunState is
    // not (or no longer) the record of that arm — the superseding run takes the
    // arm over regardless of what loadState returned.
    expect(
      inheritsArmOnSupersede({ supersededStatus: undefined, supersededArmedSend: undefined, pendingArm: { epoch: 4, atMs: 1_000 } }),
    ).toBe(true);
    expect(
      inheritsArmOnSupersede({ supersededStatus: "stopped", supersededArmedSend: undefined, pendingArm: { epoch: 4, atMs: 1_000 } }),
    ).toBe(true);
  });

  it("REGRESSION (failed-second-start variant): an INHERITED arm is a real arm — the failed-start rollback must not no-op on it", () => {
    // Run B inherited A's arm, then B's fetchQueue threw before saveState.
    // rollbackArmAfterFailedStart early-returns on armedSend=false (index.ts) —
    // the inherited arm must present as armedSend=true so the rollback's disarm
    // actually runs (while B's epoch is still current), instead of leaving the
    // switch ON with no RunState accounting for it.
    const armedSend =
      armedByManualEnable(true) ||
      inheritsArmOnSupersede({ supersededStatus: "running", supersededArmedSend: true, pendingArm: null });
    expect(armedSend).toBe(true); // !armedSend guard does NOT short-circuit
    expect(tickIsCurrent(7, 7)).toBe(true); // not superseded → rollback owns the disarm
    // And because the inheriting run stamps setPendingArm for ITS epoch, a
    // rollback whose disarm POST also fails leaves the marker standing —
    // checkAutonomy stays fail-closed (classifyPendingArm → wait/disarm, never
    // "none") until the switch is confirmed OFF.
    expect(classifyPendingArm({ epoch: 7, atMs: 0 }, ARM_PENDING_GRACE_MS + 1)).toBe("disarm");
  });
});

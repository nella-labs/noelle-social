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

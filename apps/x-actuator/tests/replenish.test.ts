import { describe, it, expect } from "vitest";
import {
  mergePool, deferLater, shortfall, retryDecision, replyFailureDecision, MAX_ACTION_TRIES,
  shouldExtendDrain, drainShouldKeepWaiting, pipelineIsDry, MAX_DRAIN_ROUNDS, preSendDecision,
  type PoolItem,
} from "../src/background/replenish.js";
import { makeRng } from "../src/lib/rng.js";

const item = (id: string): PoolItem => ({ approvalId: `approval-${id}`, draftId: id, body: "b", url: "u" });

describe("replenish helpers", () => {
  it("mergePool adds new items, skips queued + done", () => {
    const existing = [item("a")];
    const incoming = [item("a"), item("b"), item("c")];
    const done = new Set(["c"]);
    const out = mergePool(existing, incoming, done);
    expect(out.map((i) => i.draftId)).toEqual(["a", "b"]);
  });

  it("deferLater pushes the action to a later in-window time", () => {
    const now = 1_000_000;
    const end = now + 3600_000;
    const a = { kind: "comment" as const, atMs: now };
    const d = deferLater(a, now, end, makeRng(4));
    expect(d.atMs).toBeGreaterThan(now);
    expect(d.atMs).toBeLessThanOrEqual(end);
    expect(d.kind).toBe("comment");
  });

  it("deferLater never exceeds the window end", () => {
    const now = 1_000_000;
    const end = now + 60_000;
    for (let s = 0; s < 50; s++) {
      const d = deferLater({ kind: "dm", atMs: now }, now, end, makeRng(s));
      expect(d.atMs).toBeLessThanOrEqual(end);
    }
  });

  it("shortfall reports unmet target, floored at 0", () => {
    expect(shortfall(80, 47)).toBe(33);
    expect(shortfall(20, 25)).toBe(0);
  });

  it("mergePool keeps an existing item's tries untouched on replenish", () => {
    const failing: PoolItem = { ...item("a"), tries: 2 };
    const out = mergePool([failing], [item("a"), item("b")], new Set());
    expect(out.find((i) => i.draftId === "a")?.tries).toBe(2);
    expect(out.find((i) => i.draftId === "b")?.tries).toBeUndefined();
  });

  it("a failed draft re-queued at the back keeps its tries count across replenish", () => {
    // regression for the lane-starvation fix: a failed item pushed to the BACK of
    // the pool must survive a replenish merge WITH its tries intact, so its retry
    // budget keeps counting down instead of resetting and looping forever.
    const failed: PoolItem = { ...item("a"), tries: 2 };
    const merged = mergePool([failed], [item("a"), item("b")], new Set());
    expect(merged.map((i) => i.draftId)).toEqual(["a", "b"]);
    expect(merged.find((i) => i.draftId === "a")?.tries).toBe(2);
  });

  it("shouldExtendDrain: keeps draining only in drain mode, under the cap, with work left", () => {
    // extend: drain mode, room under the cap, and replies still pending
    expect(shouldExtendDrain("drain", 0, 5)).toBe(true);
    expect(shouldExtendDrain("drain", 3, 1)).toBe(true);
    // stop: nothing left in the inbox
    expect(shouldExtendDrain("drain", 0, 0)).toBe(false);
    // stop: not a drain (a normal windowed run never auto-continues)
    expect(shouldExtendDrain("scheduled", 0, 9)).toBe(false);
    expect(shouldExtendDrain(undefined, 0, 9)).toBe(false);
    // stop: round cap reached (a forever-refilling queue can't loop unattended)
    expect(shouldExtendDrain("drain", MAX_DRAIN_ROUNDS, 100)).toBe(false);
    expect(shouldExtendDrain("drain", MAX_DRAIN_ROUNDS - 1, 100)).toBe(true);
  });

  it("drainShouldKeepWaiting: a MANUAL drain stays alive on an empty inbox, ends only at the ceiling", () => {
    // The load-bearing difference from shouldExtendDrain: on an empty inbox
    // shouldExtendDrain is false (append no batch) but drainShouldKeepWaiting is
    // TRUE for a manual drain (keep the run alive, watching) — that removes the
    // operator re-click.
    expect(shouldExtendDrain("drain", 0, 0)).toBe(false);
    expect(drainShouldKeepWaiting("drain", 0)).toBe(true);
    // keeps waiting anywhere under the batch ceiling...
    expect(drainShouldKeepWaiting("drain", MAX_DRAIN_ROUNDS - 1)).toBe(true);
    // ...and only lets the run end once the runaway ceiling is actually hit.
    expect(drainShouldKeepWaiting("drain", MAX_DRAIN_ROUNDS)).toBe(false);
    // never keeps a non-drain run alive.
    expect(drainShouldKeepWaiting("scheduled", 0)).toBe(false);
    expect(drainShouldKeepWaiting(undefined, 0)).toBe(false);
  });

  it("pipelineIsDry: nothing to send ⇒ run goes quiet (the likes-with-empty-pipeline bug)", () => {
    // Regression for 2026-07-19/20: the actuator kept slipping idle-likes into the
    // waiting gaps while its pipeline was dry — Lyra logged 171 likes/22 comments
    // (Jul 19) and 184/33 (Jul 20), Vega 223 likes/34 replies (Jul 20). Dry ⇒ the
    // tick returns before any idle-like or ambient browse.
    expect(pipelineIsDry(0, 0)).toBe(true);
    // ANY supply in either lane ⇒ normal behaviour (in-gap liking is intended
    // pacing between real sends).
    expect(pipelineIsDry(1, 0)).toBe(false);
    expect(pipelineIsDry(0, 1)).toBe(false);
    expect(pipelineIsDry(3, 2)).toBe(false);
  });

  it("MAX_DRAIN_ROUNDS is a runaway backstop, not a normal stop (effectively never re-click)", () => {
    // Raised far above any real day so one Drain click is self-perpetuating —
    // server-side daily/per-author caps starve supply long before this many real
    // send-batches, so the ceiling is only a runaway guard.
    expect(MAX_DRAIN_ROUNDS).toBeGreaterThanOrEqual(1000);
  });
});

describe("reply failure policy", () => {
  it("retryDecision bumps tries and only gives up at the cap", () => {
    // first failure → try #1, keep retrying (re-queued at the back)
    expect(retryDecision(0)).toEqual({ tries: 1, giveUp: false });
    // second failure → try #2, still under a 3-strike cap
    expect(retryDecision(1)).toEqual({ tries: 2, giveUp: false });
    // third failure → try #3 == cap → drop the draft for the session
    expect(retryDecision(2)).toEqual({ tries: 3, giveUp: true });
    expect(MAX_ACTION_TRIES).toBe(3);
  });

  it("retryDecision honours a custom cap (a single strike gives up immediately)", () => {
    expect(retryDecision(0, 1)).toEqual({ tries: 1, giveUp: true });
  });

  // THE regression this policy exists for: a submit gesture (button click or
  // ⌘/Ctrl+Enter chord) was dispatched but the composer still read text — e.g.
  // the post landed slower than the ~3s observation window, or composer drift
  // left the text readable after a success. Retrying would re-type and re-post
  // the SAME reply to the SAME tweet (the reply-spam signal). The draft must be
  // dropped on the FIRST such failure, never re-queued — regardless of tries.
  it("a dispatched submit is NEVER retried, even on its first failure", () => {
    expect(replyFailureDecision(true, 0)).toEqual({ plan: "drop-ambiguous" });
    expect(replyFailureDecision(true, 1)).toEqual({ plan: "drop-ambiguous" });
    expect(replyFailureDecision(true, 99)).toEqual({ plan: "drop-ambiguous" });
  });

  it("pre-dispatch failures retry at the back, bounded, then give up", () => {
    // box-not-found style failures: nothing could have posted → bounded retry.
    expect(replyFailureDecision(false, 0)).toEqual({ plan: "retry-back", tries: 1 });
    expect(replyFailureDecision(false, 1)).toEqual({ plan: "retry-back", tries: 2 });
    // At MAX_ACTION_TRIES the draft is dropped for the session so one
    // un-submittable draft can never starve the rest of the pool.
    expect(replyFailureDecision(false, 2)).toEqual({ plan: "give-up", tries: 3 });
  });
});

describe("preSendDecision (pre-post revalidation, fail-closed)", () => {
  it("posts only a verified pending + unstamped approval", () => {
    expect(preSendDecision({ status: "pending", autosend_pending: false })).toEqual({ action: "post" });
  });

  it("drops an approval decided elsewhere (sent/skipped/errored) — no durable write, no post", () => {
    // regression for the duplicate-public-reply race: autosend (or a human)
    // flipped the status while the item sat in the pool — the browser must NOT
    // post the same reply again.
    expect(preSendDecision({ status: "sent", autosend_pending: false }))
      .toEqual({ action: "drop", reason: "superseded-sent" });
    expect(preSendDecision({ status: "skipped", autosend_pending: false }))
      .toEqual({ action: "drop", reason: "superseded-skipped" });
    expect(preSendDecision({ status: "errored", autosend_pending: true }))
      .toEqual({ action: "drop", reason: "superseded-errored" });
  });

  it("drops an autosend-owned approval (auto_send_target_at stamped mid-session)", () => {
    // still pending, but the x-intern API-autosend pipeline now owns it —
    // claimAutoSendDue will post it via the official API. Two senders on one
    // approval = duplicate public reply, so the browser stands down.
    expect(preSendDecision({ status: "pending", autosend_pending: true }))
      .toEqual({ action: "drop", reason: "autosend-owned" });
  });

  it("FAILS CLOSED when the state check is unavailable or malformed", () => {
    // never post unverified: a network error / non-2xx / bad body retries under
    // the MAX_ACTION_TRIES cap instead of posting.
    expect(preSendDecision(null)).toEqual({ action: "retry", reason: "verify-unreachable" });
    expect(preSendDecision({ status: 42 as unknown as string, autosend_pending: false }))
      .toEqual({ action: "retry", reason: "verify-unreachable" });
  });
});

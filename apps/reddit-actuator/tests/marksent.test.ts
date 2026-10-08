import { describe, it, expect, vi } from "vitest";
import { recordReplySuccess, recordReplyHold, recordRemovedSkip, markSentWithRetry, classifyRemovedProbe } from "../src/background/marksent.js";
import { mergePool } from "../src/background/replenish.js";
import { postDedupKey } from "../src/lib/urn.js";
import type { RunState, SlotAction, RedditPoolItem } from "../src/background/state.js";

const noSleep = async (): Promise<void> => {};
const rng = { float: () => 0 };

function baseState(): RunState {
  return {
    sessionId: "sess", epoch: 1, startMs: 0, windowHours: 1,
    actions: [], targets: { likes: 0, comments: 1, dms: 0 },
    done: { likes: 0, comments: 0, dms: 0 },
    commentPool: [], dmPool: [], doneDraftIds: [], lastPollMs: 0, status: "running",
    persona: {} as never, warmupSuppressMs: 0,
  };
}
const item = (over: Partial<RedditPoolItem> = {}): RedditPoolItem => ({
  approvalId: "ap1", draftId: "dr1", body: "hi", url: "https://www.reddit.com/x",
  targetType: "comment", commentId: "c1", ...over,
});

describe("recordReplySuccess — record-first bookkeeping (FIX 3)", () => {
  it("records the draft, executes the slot, bumps done, stamps lastReplyMs + lastProgressMs", () => {
    const s = baseState();
    const action: SlotAction = { kind: "comment", atMs: 0, executed: false };
    recordReplySuccess(s, action, item(), 12345);
    expect(s.doneDraftIds).toContain("dr1");
    expect(action.executed).toBe(true);
    expect(s.done.comments).toBe(1);
    expect(s.lastReplyMs).toBe(12345);
    // stall-recovery reads lastProgressMs: a landed reply IS progress.
    expect(s.lastProgressMs).toBe(12345);
  });

  it("a recorded draft is NOT re-queued by replenish (mergePool drops it)", () => {
    const s = baseState();
    const action: SlotAction = { kind: "comment", atMs: 0, executed: false };
    const it0 = item();
    recordReplySuccess(s, action, it0, 1);
    // The approval is still pending server-side (markSent failed), so the next
    // fetchQueue returns it again — mergePool MUST drop it (its draftId is done).
    const merged = mergePool(s.commentPool, [it0], new Set(s.doneDraftIds));
    expect(merged).toHaveLength(0);
  });

  it("records the per-THREAD dedup key (ports #408): a second draft for the same thread matches it", () => {
    const s = baseState();
    const action: SlotAction = { kind: "comment", atMs: 0, executed: false };
    recordReplySuccess(s, action, item({ url: "https://www.reddit.com/r/SaaS/comments/abc123/x/" }), 1);
    expect(s.actionedKeys).toEqual(["t3_abc123"]);
    // A comment-target permalink in the SAME thread collapses to the same key —
    // this is exactly what the tick-loop duplicate-post guard compares against.
    expect(s.actionedKeys).toContain(
      postDedupKey("https://www.reddit.com/r/SaaS/comments/abc123/x/def456/"),
    );
  });

  it("actionedKeys initializes lazily on a pre-upgrade state (optional field, ??=)", () => {
    const s = baseState(); // baseState carries no actionedKeys, like a persisted old RunState
    expect(s.actionedKeys).toBeUndefined();
    const action: SlotAction = { kind: "comment", atMs: 0, executed: false };
    recordReplySuccess(s, action, item(), 1);
    expect(s.actionedKeys).toHaveLength(1);
  });
});

describe("recordRemovedSkip — removed-post skip is terminal (no reply, no retry)", () => {
  it("consumes the slot, records the draft done, emits a post-removed skip, counts NO reply", () => {
    const s = baseState();
    const action: SlotAction = { kind: "comment", atMs: 0, executed: false };
    const ev = recordRemovedSkip(s, action, item(), "2026-07-11T00:00:00.000Z");
    expect(action.executed).toBe(true);     // slot consumed → won't re-fire
    expect(s.doneDraftIds).toContain("dr1"); // draft recorded done
    expect(s.done.comments).toBe(0);         // NOT counted as a reply (never posted)
    expect(s.lastReplyMs).toBeUndefined();   // min-spacing floor untouched (no reply landed)
    expect(s.lastProgressMs).toBeUndefined(); // a skip is NOT progress — stall-recovery must still see it stalled
    expect(ev).toEqual({ type: "skip", reason: "post-removed", at: "2026-07-11T00:00:00.000Z" });
  });

  it("a removed draft is NOT re-queued by replenish (mergePool drops it) — never retried", () => {
    const s = baseState();
    const action: SlotAction = { kind: "comment", atMs: 0, executed: false };
    const it0 = item();
    recordRemovedSkip(s, action, it0, new Date().toISOString());
    // We never markSent a removed post, so a later fetchQueue can return it again —
    // mergePool MUST drop it (its draftId is done) so the dead post is never retried.
    expect(mergePool([], [it0], new Set(s.doneDraftIds))).toHaveLength(0);
  });
});

describe("classifyRemovedProbe — durable markSkipped requires POSITIVE removal evidence", () => {
  it("a healthy page (removed:false) or a failed probe (null) ⇒ no removed outcome", () => {
    expect(classifyRemovedProbe({ removed: false })).toBeNull();
    expect(classifyRemovedProbe(null)).toBeNull();
    expect(classifyRemovedProbe(undefined)).toBeNull();
  });

  it("positive removal evidence (attr/class/matched phrase) ⇒ durable post-removed skip", () => {
    for (const reason of ["removed-attr", "thing-deleted", "removed by reddit's filters"]) {
      expect(classifyRemovedProbe({ removed: true, reason, positive: true })).toEqual({
        kind: "removed", reason: "post-removed", durable: true,
      });
    }
  });

  it("REGRESSION: post-absent (transient 5xx/CDN interstitial, age gate) ⇒ NON-durable session-local skip", () => {
    // Pre-fix, this fed api.markSkipped and irreversibly flipped a human-approved
    // pending approval to 'skipped' on a page state that self-heals next run.
    expect(classifyRemovedProbe({ removed: true, reason: "post-absent" })).toEqual({
      kind: "removed", reason: "post-unavailable", durable: false,
    });
  });

  it("fails CLOSED: a probe without the positive flag (stale content script) is never durable", () => {
    expect(classifyRemovedProbe({ removed: true })).toEqual({
      kind: "removed", reason: "post-unavailable", durable: false,
    });
    expect(classifyRemovedProbe({ removed: true, reason: "this post has been removed" })).toEqual({
      kind: "removed", reason: "post-unavailable", durable: false,
    });
  });
});

describe("markSentWithRetry — a failure never re-posts (FIX 3)", () => {
  it("returns true when markSent succeeds on the first try", async () => {
    const api = { markSent: vi.fn().mockResolvedValue(undefined), logActivity: vi.fn().mockResolvedValue(undefined) };
    const ok = await markSentWithRetry(api, "ap1", "sess", rng, noSleep);
    expect(ok).toBe(true);
    expect(api.markSent).toHaveBeenCalledTimes(1);
    expect(api.logActivity).not.toHaveBeenCalled();
  });

  it("a markSent that KEEPS rejecting is swallowed (returns false, never throws) and logged", async () => {
    const api = { markSent: vi.fn().mockRejectedValue(new Error("500")), logActivity: vi.fn().mockResolvedValue(undefined) };
    const ok = await markSentWithRetry(api, "ap1", "sess", rng, noSleep);
    expect(ok).toBe(false); // did NOT throw → the tick keeps the local record, no re-post
    expect(api.markSent).toHaveBeenCalledTimes(3); // retried
    expect(api.logActivity).toHaveBeenCalledTimes(1); // logged to the skip channel
    expect(api.logActivity.mock.calls[0]![1]![0]).toMatchObject({ type: "skip", reason: "marksent-failed" });
  });

  it("end-to-end: markSent rejecting AFTER a success record leaves the slot done + item not re-queued", async () => {
    const s = baseState();
    const action: SlotAction = { kind: "comment", atMs: 0, executed: false };
    const it0 = item();
    recordReplySuccess(s, action, it0, 1); // record-first
    const api = { markSent: vi.fn().mockRejectedValue(new Error("network")), logActivity: vi.fn().mockResolvedValue(undefined) };
    await expect(markSentWithRetry(api, it0.approvalId, s.sessionId, rng, noSleep)).resolves.toBe(false);
    // The local record SURVIVED the markSent failure — no duplicate post possible.
    expect(s.doneDraftIds).toContain("dr1");
    expect(action.executed).toBe(true);
    expect(mergePool([], [it0], new Set(s.doneDraftIds))).toHaveLength(0);
  });
});


it("holds an unknown outcome without recording a successful reply or progress", () => {
  const s = baseState(); const action: SlotAction = { kind: "comment", atMs: 0, executed: false };
  const captured = item({ url: "https://www.reddit.com/comments/abc123/title/" });
  recordReplyHold(s, action, captured);
  expect(s.doneDraftIds).toContain(captured.draftId); expect(action.executed).toBe(true);
  expect(s.actionedKeys).toContain("t3_abc123"); expect(s.done.comments).toBe(0);
  expect(s.lastReplyMs).toBeUndefined(); expect(s.lastProgressMs).toBeUndefined();
  expect(mergePool([], [captured], new Set(s.doneDraftIds))).toEqual([]);
});

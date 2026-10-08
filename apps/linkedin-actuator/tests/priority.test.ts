import { describe, expect, it } from "vitest";
import { makeRng } from "../src/lib/rng.js";
import { advancePriorityCursor, claimCommentForSend, classifyWithheldApproval, integratePriorityReady, isApprovalStillActionable, priorityTickDecision, restoreWithheldItem } from "../src/background/priority.js";
import type { RunState } from "../src/background/state.js";
import type { ActionableLinkedInResponse } from "@noelle/contracts";

const comment = (id: string) => ({
  approval_id: id, draft_id: `draft-${id}`, body: "A specific reply",
  target: { url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/` },
}) as ActionableLinkedInResponse["comments"][number];

function state(mode: "drain" | "scheduled" = "drain"): RunState {
  return {
    sessionId: "s", epoch: 1, startMs: 1000, windowHours: 1,
    actions: [{ kind: "comment", atMs: 2000, executed: true }],
    targets: { likes: 0, comments: 1, dms: 0 }, done: { likes: 0, comments: 1, dms: 0 },
    commentPool: [], dmPool: [], doneDraftIds: [], lastPollMs: 1000,
    status: "running", mode, persona: {} as RunState["persona"], warmupSuppressMs: 0,
    lastProgressMs: 10_000,
  };
}

describe("integratePriorityReady", () => {
  it("adds a drain slot at the existing gap after the last send", () => {
    const s = state();
    const added = integratePriorityReady(s, [comment("1234567890")], 20_000, makeRng(1));
    expect(added).toBe(1);
    expect(s.commentPool.map((item) => item.approvalId)).toEqual(["1234567890"]);
    expect(s.actions.filter((a) => !a.executed && a.kind === "comment")).toHaveLength(1);
    expect(s.actions.filter((a) => !a.executed && a.kind === "comment")[0]!.atMs).toBeGreaterThanOrEqual(70_000);
  });

  it("does not duplicate a pooled approval or create extra slots", () => {
    const s = state();
    integratePriorityReady(s, [comment("1234567890")], 20_000, makeRng(1));
    const count = s.actions.length;
    expect(integratePriorityReady(s, [comment("1234567890")], 21_000, makeRng(2))).toBe(0);
    expect(s.actions).toHaveLength(count);
  });

  it("keeps a scheduled run's existing send slots", () => {
    const s = state("scheduled");
    integratePriorityReady(s, [comment("1234567890")], 20_000, makeRng(1));
    expect(s.actions).toHaveLength(1);
    expect(s.commentPool).toHaveLength(1);
  });

  it("does not add drain slots while a planned slot is still pending", () => {
    const s = state();
    s.actions.push({ kind: "comment", atMs: 200_000, executed: false });
    integratePriorityReady(s, [comment("1234567890")], 20_000, makeRng(1));
    expect(s.actions).toHaveLength(2);
    expect(s.commentPool).toHaveLength(1);
  });

  it("ignores a wake after STOP or a challenge halt", () => {
    for (const status of ["stopped", "halted-challenge"] as const) {
      const s = state();
      s.status = status;
      expect(integratePriorityReady(s, [comment("1234567890")], 20_000, makeRng(1))).toBe(0);
      expect(s.commentPool).toHaveLength(0);
      expect(s.actions).toHaveLength(1);
    }
  });

  it("defers wake processing until an in-flight tick finishes", () => {
    expect(priorityTickDecision(true)).toBe("defer");
    expect(priorityTickDecision(false)).toBe("tick");
  });

  it("keeps the request-start cursor so an approval arriving before the response is seen next", () => {
    expect(advancePriorityCursor(1000, 2000, 3000)).toBe(2000);
  });

  it("rechecks server gates at the actual send slot", async () => {
    const item = comment("1234567890");
    const blocked = { fetchQueue: async () => ({ comments: [], dms: [] }) };
    expect(await isApprovalStillActionable(blocked, "comment", item.approval_id)).toBe(false);
    const allowed = { fetchQueue: async () => ({ comments: [item], dms: [] }) };
    expect(await isApprovalStillActionable(allowed, "comment", item.approval_id)).toBe(true);
    expect(await isApprovalStillActionable({ fetchQueue: async () => { throw new Error("offline"); } }, "comment", item.approval_id)).toBe(false);
  });

  it("never authorizes a comment without an accepted server claim", async () => {
    expect(await claimCommentForSend({ claimComment: async () => ({ claimed: true }) }, "approval"))
      .toBe("claimed");
    expect(await claimCommentForSend({ claimComment: async () => ({ claimed: false }) }, "approval"))
      .toBe("already-claimed");
    expect(await claimCommentForSend({ claimComment: async () => { throw new Error("offline"); } }, "approval"))
      .toBe("unavailable");
  });

  it("restores a withheld approval for its deferred slot unless the run stopped", () => {
    const s = state();
    integratePriorityReady(s, [comment("1234567890")], 20_000, makeRng(1));
    const item = s.commentPool.shift()!;
    expect(s.commentPool).toHaveLength(0);
    restoreWithheldItem(s.commentPool, item, true);
    expect(s.commentPool.map((entry) => entry.approvalId)).toEqual(["1234567890"]);
    restoreWithheldItem(s.commentPool, item, true);
    expect(s.commentPool).toHaveLength(1);
    const stoppedPool: typeof s.commentPool = [];
    restoreWithheldItem(stoppedPool, item, false);
    expect(stoppedPool).toHaveLength(0);
  });

  it("drops a terminal or review-deferred approval instead of restoring it", async () => {
    for (const status of ["sent", "skipped", "expired", "errored"]) {
      expect(await classifyWithheldApproval({ fetchApprovalState: async () => ({ status, autosend_pending: false }) }, "id"))
        .toEqual({ kind: "drop", terminal: true, reason: status });
    }
    expect(await classifyWithheldApproval({ fetchApprovalState: async () => ({ status: "deferred", autosend_pending: false }) }, "id"))
      .toEqual({ kind: "drop", terminal: false, reason: "deferred" });
    expect(await classifyWithheldApproval({ fetchApprovalState: async () => ({ status: "pending", autosend_pending: true }) }, "id"))
      .toEqual({ kind: "drop", terminal: false, reason: "autosend-owned" });
  });

  it("bounds local retries for a still-pending or unknown approval", async () => {
    expect(await classifyWithheldApproval({ fetchApprovalState: async () => ({ status: "pending", autosend_pending: false }) }, "id"))
      .toEqual({ kind: "retry", reason: "pending" });
    expect(await classifyWithheldApproval({ fetchApprovalState: async () => { throw new Error("offline"); } }, "id"))
      .toEqual({ kind: "retry", reason: "state-unavailable" });
    const item = { approvalId: "id", draftId: "draft", body: "Reply", url: "https://www.linkedin.com/feed/update/urn:li:activity:1234567890/" };
    const pool: typeof item[] = [];
    expect(restoreWithheldItem(pool, item, true)).toBe(true);
    pool.shift();
    expect(restoreWithheldItem(pool, item, true)).toBe(true);
    pool.shift();
    expect(restoreWithheldItem(pool, item, true)).toBe(false);
    expect(pool).toHaveLength(0);
  });
});

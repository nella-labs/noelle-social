import { describe, expect, it, vi } from "vitest";
import {
  pendingReplySkipReason,
  reconcilePendingReplyBacklog,
  type PendingReplyBacklogCandidate,
  type PendingReplyReconcileStore,
} from "./pending-reply-reconcile.js";

const policy = {
  linkedinVoiceFloor: 0.7,
  xMaxAgeHours: 25,
  notificationMaxAgeHours: 12,
  now: new Date("2026-09-20T20:00:00.000Z"),
};

function row(overrides: Partial<PendingReplyBacklogCandidate> = {}): PendingReplyBacklogCandidate {
  return {
    approvalId: "approval-1",
    approvalCreatedAt: "2026-09-20T19:00:00.000Z",
    draftId: "draft-1",
    leadId: "lead-1",
    leadExternalId: "target-1",
    orgId: "org-1",
    agentInstanceId: "instance-1",
    platform: "linkedin",
    draftPayload: {
      kind: "reply",
      body: "A concrete reply",
      verifier_meta: { pass: true, judgeOk: true, scores: { voice: 0.8 } },
    },
    leadPayload: { posted_at: "2026-09-20T19:00:00.000Z" },
    ...overrides,
  };
}

describe("pending reply backlog disposition", () => {
  it("keeps a valid LinkedIn reply pending", () => {
    expect(pendingReplySkipReason(row(), policy)).toBeNull();
  });

  it.each([
    [{ kind: "reply" }, "automatic-review-missing"],
    [{ kind: "reply", verifier_meta: { pass: false, judgeOk: true } }, "automatic-review-failed"],
    [{ kind: "reply", verifier_meta: { pass: true, judgeOk: false } }, "automatic-review-invalid-judge"],
    [{ kind: "reply", verifier_meta: { pass: true, judgeOk: true, scores: {} } }, "automatic-review-low-voice"],
    [{ kind: "reply", verifier_meta: { pass: true, judgeOk: true, scores: { voice: 0.69 } } }, "automatic-review-low-voice"],
  ] as const)("classifies unusable LinkedIn review %#", (draftPayload, expected) => {
    expect(pendingReplySkipReason(row({ draftPayload }), policy)).toBe(expected);
  });

  it("classifies an explicit unresolved human-review flag", () => {
    expect(pendingReplySkipReason(row({
      draftPayload: {
        kind: "reply",
        human_review_required: true,
        verifier_meta: { pass: true, judgeOk: true, scores: { voice: 0.9 } },
      },
    }), policy)).toBe("automatic-review-human-required");
  });

  it("keeps a valid X reply and expires a stale ordinary target", () => {
    const valid = row({
      platform: "x",
      draftPayload: { kind: "reply", verifier_meta: { pass: true, judgeOk: true } },
    });
    expect(pendingReplySkipReason(valid, policy)).toBeNull();
    expect(pendingReplySkipReason({
      ...valid,
      leadPayload: { posted_at: "2026-09-19T18:00:00.000Z" },
    }, policy)).toBe("automatic-review-expired");
  });

  it("uses the notification window and exempts Jev browser observations", () => {
    const x = row({
      platform: "x",
      draftPayload: { kind: "reply", verifier_meta: { pass: true, judgeOk: true } },
      leadPayload: { source: "notification", posted_at: "2026-09-20T07:00:00.000Z" },
    });
    expect(pendingReplySkipReason(x, policy)).toBe("automatic-review-expired");
    expect(pendingReplySkipReason({
      ...x,
      leadPayload: {
        source: "extension_observed",
        classifier: { judge: "jev" },
        posted_at: "2026-09-18T07:00:00.000Z",
      },
    }, policy)).toBeNull();
  });

  it("fails open on an unknown X post time and when the age ceiling is disabled", () => {
    const x = row({
      platform: "x",
      draftPayload: { kind: "reply", verifier_meta: { pass: true, judgeOk: true } },
      leadPayload: { posted_at: "unknown" },
    });
    expect(pendingReplySkipReason(x, policy)).toBeNull();
    expect(pendingReplySkipReason({
      ...x,
      leadPayload: { posted_at: "2020-01-01T00:00:00.000Z" },
    }, { ...policy, xMaxAgeHours: 0 })).toBeNull();
  });

  it("never disposes DMs", () => {
    expect(pendingReplySkipReason(row({
      draftPayload: { kind: "dm", verifier_meta: { pass: false, judgeOk: false } },
    }), policy)).toBeNull();
  });

  it("keeps an impossible calendar source time unknown", () => {
    expect(pendingReplySkipReason(row({ platform: "x", leadPayload: {
      posted_at: "2026-02-30T19:00:00Z",
    } }), policy)).toBeNull();
  });
});

describe("pending reply backlog reconciliation", () => {
  it("keeps the same oldest target winner across bounded pages", async () => {
    const rows = Array.from({ length:201 }, (_, i) => row({ approvalId:String(i).padStart(4,"0"),draftId:`d${i}`,leadId:`l${i}` }));
    const store: PendingReplyReconcileStore = {
      list:vi.fn().mockResolvedValueOnce(rows.slice(0,200)).mockResolvedValueOnce(rows.slice(200)),
      skip:vi.fn(async () => true),
    };
    const counts = await reconcilePendingReplyBacklog({ orgId:"org-1",store,policy,apply:true });
    expect(counts).toMatchObject({ selected:201,kept:1,planned:200,skipped:200 });
    expect(store.list).toHaveBeenCalledTimes(2);
  });
  it("keeps one deterministic valid reply per lead and target, then skips siblings", async () => {
    const rows = [
      row({ approvalId: "newer", draftId: "d3", leadId: "lead-2", approvalCreatedAt: "2026-09-20T19:30:00Z" }),
      row({ approvalId: "oldest", draftId: "d1", approvalCreatedAt: "2026-09-20T18:00:00Z" }),
      row({ approvalId: "same-lead", draftId: "d2", leadExternalId: "other-target", approvalCreatedAt: "2026-09-20T19:00:00Z" }),
    ];
    const skipped: string[] = [];
    const store: PendingReplyReconcileStore = {
      list: vi.fn(async () => rows),
      skip: vi.fn(async (candidate) => { skipped.push(candidate.approvalId); return true; }),
    };

    const counts = await reconcilePendingReplyBacklog({ orgId: "org-1", store, policy, apply: true });

    expect(skipped).toEqual(["same-lead", "newer"]);
    expect(counts).toMatchObject({ selected: 3, kept: 1, planned: 2, skipped: 2, stale: 0 });
    expect(counts.byReason["automatic-review-sibling"]).toBe(2);
  });

  it("is tenant-safe, dry-run safe, and leaves valid replies untouched", async () => {
    const store: PendingReplyReconcileStore = {
      list: vi.fn(async () => [
        row(),
        row({ approvalId: "bad", draftId: "bad", leadId: "bad", draftPayload: { kind: "reply" } }),
        row({ approvalId: "foreign", orgId: "org-2", draftPayload: { kind: "reply" } }),
      ]),
      skip: vi.fn(async () => true),
    };

    const counts = await reconcilePendingReplyBacklog({ orgId: "org-1", store, policy, apply: false });

    expect(counts).toMatchObject({ selected: 2, kept: 1, planned: 1, skipped: 0, stale: 0 });
    expect(store.skip).not.toHaveBeenCalled();
  });
});

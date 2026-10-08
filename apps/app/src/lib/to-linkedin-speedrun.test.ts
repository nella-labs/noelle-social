import { describe, it, expect } from "vitest";
import { toLinkedInSpeedrunDrafts } from "./to-linkedin-speedrun";
import type { LinkedInApprovalView } from "./queries";

function view(over: Partial<LinkedInApprovalView>): LinkedInApprovalView {
  return {
    approvalId: "a",
    status: "pending",
    createdAt: "2026-06-11T00:00:00Z",
    kind: "reply",
    authorName: "Kaia Tham",
    authorHeadline: null,
    authorPublicId: "kaia-tham",
    profileUrl: "https://www.linkedin.com/in/kaia-tham/",
    postText: "post A",
    postUrl: "https://lnkd.in/A",
    postedAt: "2026-06-10T00:00:00Z",
    body: "reply body",
    angle: "empathetic",
    charCount: 10,
    styleSource: null,
    ...over,
  };
}

describe("toLinkedInSpeedrunDrafts", () => {
  it("uses a passing sibling as the post card and reports quality readiness", () => {
    const [card] = toLinkedInSpeedrunDrafts([
      view({ approvalId: "failed", verifierMeta: null }),
      view({ approvalId: "passed", verifierMeta: { pass: true, judgeOk: true, scores: { voice: 0.8 } } }),
    ], undefined, new Set(), 0.7);
    expect(card!.id).toBe("passed");
    expect(card!.readyForActor).toBe(true);
    expect(card!.angles).toHaveLength(2);
  });

  it("leaves a reviewed post unclassified when the actor policy cannot be loaded", () => {
    const [card] = toLinkedInSpeedrunDrafts([
      view({ approvalId: "passed", verifierMeta: { pass: true, judgeOk: true, scores: { voice: 0.9 } } }),
    ], undefined, new Set(), null);
    expect(card!.readyForActor).toBe(false);
    expect(card!.reviewPolicyAvailable).toBe(false);
  });

  it("groups reply angles per post into one card (rep approvalId = card id)", () => {
    const out = toLinkedInSpeedrunDrafts([
      view({ approvalId: "a1", angle: "empathetic", body: "e" }),
      view({ approvalId: "a2", angle: "technical", body: "t" }),
      view({ approvalId: "a3", angle: "contrarian", body: "c" }),
      view({
        approvalId: "b1",
        postUrl: "https://lnkd.in/B",
        postText: "post B",
        body: "eb",
      }),
    ]);
    expect(out).toHaveLength(2); // 2 distinct posts
    expect(out[0]!.angles).toHaveLength(3);
    expect(out[0]!.id).toBe("a1"); // representative reply approval
    expect(out[0]!.angles.map((a) => a.approvalId)).toEqual(["a1", "a2", "a3"]);
    expect(out[0]!.angles.map((a) => a.kind)).toEqual([
      "Empathetic",
      "Technical",
      "Contrarian",
    ]);
    expect(out[0]!.dmText).toBeNull();
    expect(out[0]!.lead.handle).toBe("Kaia Tham");
    expect(out[1]!.angles).toHaveLength(1);
  });

  it("keeps a standalone Friendly DM as an actionable DM card", () => {
    const out = toLinkedInSpeedrunDrafts([
      view({ approvalId: "dm-1", kind: "dm", angle: null, body: "dm body", postKind: "relationship_dm" }),
    ]);
    expect(out).toEqual([
      expect.objectContaining({
        id: "dm-1",
        kind: "dm",
        dmApprovalId: "dm-1",
        dmText: "dm body",
        angles: [],
      }),
    ]);
  });

  it("keeps a companion DM on its reply card with the DM approval id", () => {
    const [card] = toLinkedInSpeedrunDrafts([
      view({ approvalId: "reply-1", kind: "reply", body: "reply body" }),
      view({ approvalId: "dm-1", kind: "dm", angle: null, body: "companion DM" }),
    ]);

    expect(card).toMatchObject({
      kind: "reply",
      dmApprovalId: "dm-1",
      dmText: "companion DM",
    });
  });

  it("skips empty-body replies", () => {
    expect(toLinkedInSpeedrunDrafts([view({ body: "   " })])).toHaveLength(0);
    expect(toLinkedInSpeedrunDrafts([view({ body: null })])).toHaveLength(0);
  });
});

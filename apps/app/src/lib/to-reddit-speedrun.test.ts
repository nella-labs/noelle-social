import { describe, it, expect } from "vitest";
import { toRedditSpeedrunDrafts } from "./to-reddit-speedrun";
import type { RedditApprovalView } from "./queries";

function view(over: Partial<RedditApprovalView>): RedditApprovalView {
  return {
    approvalId: "a",
    status: "pending",
    createdAt: "2026-06-11T00:00:00Z",
    authorHandle: "spez",
    subreddit: "SaaS",
    threadTitle: "How do you handle churn?",
    postText: "thread body A",
    postUrl: "https://reddit.com/r/SaaS/A",
    postedAt: "2026-06-10T00:00:00Z",
    body: "reply body",
    ...over,
  };
}

describe("toRedditSpeedrunDrafts", () => {
  it("groups reply angles per thread into one card (rep approvalId = card id)", () => {
    const out = toRedditSpeedrunDrafts([
      view({ approvalId: "a1", body: "r1" }),
      view({ approvalId: "a2", body: "r2" }),
      view({ approvalId: "a3", body: "r3" }),
      view({
        approvalId: "b1",
        postUrl: "https://reddit.com/r/SaaS/B",
        threadTitle: "Pricing experiments",
        body: "rb",
      }),
    ]);
    expect(out).toHaveLength(2); // 2 distinct threads
    expect(out[0]!.angles).toHaveLength(3);
    expect(out[0]!.id).toBe("a1"); // representative reply approval
    expect(out[0]!.angles.map((a) => a.approvalId)).toEqual(["a1", "a2", "a3"]);
    // Numbered only when more than one angle (single → plain "Reply").
    expect(out[0]!.angles.map((a) => a.kind)).toEqual([
      "Reply 1",
      "Reply 2",
      "Reply 3",
    ]);
    expect(out[0]!.dmText).toBeNull(); // Reddit is replies-only
    expect(out[0]!.lead.handle).toBe("u/spez");
    expect(out[0]!.sourceTweet).toBe("How do you handle churn?");
    expect(out[1]!.angles).toHaveLength(1);
    expect(out[1]!.angles[0]!.kind).toBe("Reply");
  });

  it("falls back to subreddit::title key when a thread has no postUrl", () => {
    const out = toRedditSpeedrunDrafts([
      view({ approvalId: "a1", postUrl: null, body: "r1" }),
      view({ approvalId: "a2", postUrl: null, body: "r2" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.angles).toHaveLength(2);
  });

  it("skips empty-body replies", () => {
    expect(toRedditSpeedrunDrafts([view({ body: "   " })])).toHaveLength(0);
    expect(toRedditSpeedrunDrafts([view({ body: null })])).toHaveLength(0);
  });
});

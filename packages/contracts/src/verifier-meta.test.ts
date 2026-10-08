import { describe, expect, it } from "vitest";
import { OutboundInSchema } from "./outbound.js";
import { PostVerifierMetaSchema } from "./posts.js";

const meta = {
  pass: true,
  scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 1 },
  reasons: [], attempts: 0, judgeOk: true, judgeProvider: "jev",
};

describe("persisted verifier evidence", () => {
  it("retains the actual judge and genuine-verdict signal on replies", () => {
    const parsed = OutboundInSchema.parse({
      leadId: "lead", batchNumber: null, platform: "linkedin", authorHandle: "writer",
      authorId: "writer", authorFollowers: null, allowsDms: null,
      originalPostId: "post", originalPostText: "A post", originalPostUrl: "https://linkedin.com/feed/update/post",
      postedAt: "2026-09-19T00:00:00.000Z", matchedTrigger: null,
      drafts: [{ id: "reply", kind: "reply", angle: "technical", body: "A reply", charCount: 7 }],
      verifierMeta: meta,
    });
    expect(parsed.verifierMeta).toMatchObject({ judgeOk: true, judgeProvider: "jev" });
  });

  it("retains the actual judge and genuine-verdict signal on posts", () => {
    expect(PostVerifierMetaSchema.parse(meta)).toMatchObject({ judgeOk: true, judgeProvider: "jev" });
  });
});

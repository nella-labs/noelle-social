import { describe, it, expect, vi } from "vitest";
import { OutboundInSchema } from "../outbound.js";

const valid = {
  leadId: "lead-uuid-here",
  batchNumber: 1,
  platform: "x" as const,
  authorHandle: "pmarca",
  authorId: "12345",
  authorFollowers: 1_500_000,
  allowsDms: true,
  originalPostId: "p1",
  originalPostText: "Cursor is broken again",
  originalPostUrl: "https://x.com/pmarca/status/1",
  postedAt: "2026-05-17T12:34:56Z",
  matchedTrigger: "tired of cursor",
  drafts: [
    {
      id: "d1",
      kind: "reply" as const,
      angle: "empathetic" as const,
      body: "hey, that pattern is rough",
      charCount: 28,
    },
  ],
  qualityScore: 0.87,
  qualityGatePassed: true,
  tier: "T1" as const,
  postKind: "rant",
};

describe("OutboundInSchema", () => {
  it("preserves operator request identity and requires review on the wire", () => {
    const parsed = OutboundInSchema.parse({ ...valid, replyRequestKey: "request-123", humanReviewRequired: true });
    expect(parsed).toMatchObject({ replyRequestKey: "request-123", humanReviewRequired: true });
  });

  it("accepts the drafter payload shape", () => {
    expect(OutboundInSchema.safeParse(valid).success).toBe(true);
  });

  it("preserves an explicitly unknown source timestamp on the outbound wire", () => {
    const parsed = OutboundInSchema.parse({ ...valid, postedAt: null });
    expect(parsed.postedAt).toBeNull();
  });

  it("requires at least one draft", () => {
    const r = OutboundInSchema.safeParse({ ...valid, drafts: [] });
    expect(r.success).toBe(false);
  });

  it("accepts optional voice anchors and parses their shape", () => {
    const r = OutboundInSchema.safeParse({
      ...valid,
      anchors: [
        { snippet: "ship small, ship often", score: 5.1 },
        { snippet: "alignment is a systems problem", score: 3.4 },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.anchors).toHaveLength(2);
  });

  it("rejects invalid angle", () => {
    const r = OutboundInSchema.safeParse({
      ...valid,
      drafts: [{ ...valid.drafts[0], angle: "nope" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-URL originalPostUrl", () => {
    const r = OutboundInSchema.safeParse({
      ...valid,
      originalPostUrl: "not-a-url",
    });
    expect(r.success).toBe(false);
  });

  it("accepts optional quality fields as omitted", () => {
    const {
      qualityScore: _qs,
      qualityGatePassed: _qg,
      tier: _t,
      postKind: _pk,
      ...minimal
    } = valid;
    expect(OutboundInSchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts a kind='dm' draft with a null angle", () => {
    const r = OutboundInSchema.safeParse({
      ...valid,
      drafts: [
        valid.drafts[0],
        {
          id: "dm1",
          kind: "dm" as const,
          angle: null,
          body: "hellooo\n\nsaw your post about cursor\n\ngetnella.dev",
          charCount: 49,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a kind='reply' draft with a null angle", () => {
    const r = OutboundInSchema.safeParse({
      ...valid,
      drafts: [{ ...valid.drafts[0], angle: null }],
    });
    expect(r.success).toBe(false);
  });
});

describe("Reddit outbound target binding", () => {
  const originalPostUrl = "https://www.reddit.com/r/SaaS/comments/abc123/title/";
  const reddit = { ...valid, platform: "reddit", originalPostId: "abc123", originalPostUrl };
  const draft = { ...valid.drafts[0]!, replyTarget: { kind: "comment", commentId: "def456",
    permalink: `${originalPostUrl}def456/`, author: "comment_author" } };
  it.each([
    ["different source post", { originalPostUrl: "https://www.reddit.com/r/SaaS/comments/other9/title/" }],
    ["malformed source ID", { originalPostId: "abc123!" }],
    ["foreign source host", { originalPostUrl: originalPostUrl.replace("www.reddit.com", "example.test") }],
  ])("rejects %s on Reddit", (_, change) => {
    expect(OutboundInSchema.safeParse({ ...reddit, ...change }).success).toBe(false);
  });
  it.each([
    ["different thread", "/r/SaaS/comments/other9/title/def456/"],
    ["different comment", "/r/SaaS/comments/abc123/title/other9/"],
    ["different subreddit", "/r/Other/comments/abc123/title/def456/"],
    ["foreign host", "https://example.test/r/SaaS/comments/abc123/title/def456/"],
  ])("rejects a comment in a %s before ingestion", (_, permalink) => {
    expect(OutboundInSchema.safeParse({ ...reddit, drafts: [{ ...draft, replyTarget: { ...draft.replyTarget, permalink } }] }).success).toBe(false);
  });
  it("preserves a matching fullname, relative comment and explicit owner", () => {
    const owner = { orgId: "11111111-1111-4111-8111-111111111111", agentInstanceId: "22222222-2222-4222-8222-222222222222" };
    const parsed = OutboundInSchema.parse({ ...reddit, owner, originalPostId: "t3_abc123",
      drafts: [{ ...draft, replyTarget: { ...draft.replyTarget, commentId: "t1_def456", permalink: "/r/SaaS/comments/abc123/title/def456/" } }] });
    expect(parsed.owner).toEqual(owner); expect(parsed.drafts[0]?.replyTarget?.commentId).toBe("t1_def456");
  });
  it.each(["x", "linkedin"])("preserves existing %s identity semantics", platform => {
    expect(OutboundInSchema.parse({ ...valid, platform }).originalPostId).toBe("p1");
  });
});

describe("outbound saved factual context", () => {
  const context = { version: 1, platform: "x", postText: "Measured source", knowledgeAnchors: [] };
  const withContext = (reviewContext: unknown) => ({ ...valid, drafts: [{ ...valid.drafts[0]!, reviewContext }] });

  it("preserves the factual channels while excluding voice and request directives", () => {
    const parsed = OutboundInSchema.parse(withContext({ ...context,
      operatorFacts: ["Oriole maps Atlas"], conversation: { our_reply_text: "Measured prior turn" },
      personProfile: null, imageCaption: "A measured chart", voiceAnchors: ["Style-only noun"], objective: "Request-only noun" }));
    expect(parsed.drafts[0]).toHaveProperty("reviewContext", { ...context,
      operatorFacts: ["Oriole maps Atlas"], conversation: { our_reply_text: "Measured prior turn" },
      personProfile: null, imageCaption: "A measured chart" });
  });

  it("keeps explicit empty factual channels distinct from a legacy omission", () => {
    expect(OutboundInSchema.parse(valid).drafts[0]).not.toHaveProperty("reviewContext");
    expect(OutboundInSchema.parse(withContext({ ...context, postText: "", operatorFacts: [], conversation: null })).drafts[0])
      .toHaveProperty("reviewContext", { ...context, postText: "", operatorFacts: [], conversation: null });
  });

  it("rejects oversized fields before allocating an aggregate encoded snapshot", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      expect(OutboundInSchema.safeParse(withContext({ ...context, knowledgeAnchors: Array(33).fill("k".repeat(8_000)) })).success)
        .toBe(false);
      expect(encode.mock.calls.length).toBe(0);
    } finally { encode.mockRestore(); }
  });

  it.each([
    { ...context, platform: "linkedin" },
    { ...context, version: 2 },
    { ...context, postText: "s".repeat(50_001) },
    { ...context, authorHandle: "a".repeat(513) },
    { ...context, operatorFacts: Array(33).fill("fact") },
    { ...context, knowledgeAnchors: Array(33).fill("knowledge") },
    { ...context, knowledgeAnchors: ["k".repeat(8_001)] },
    { ...context, operatorFacts: ["f".repeat(8_001)] },
    { ...context, conversation: { root_post_text: "r".repeat(10_001) } },
    { ...context, personProfile: "p".repeat(16_001) },
    { ...context, imageCaption: "i".repeat(16_001) },
    { ...context, postText: "🙂".repeat(16_384) },
  ])("rejects a mismatched, malformed or over-limit factual context %#", (invalid) => {
    expect(OutboundInSchema.safeParse(withContext(invalid)).success).toBe(false);
  });
});

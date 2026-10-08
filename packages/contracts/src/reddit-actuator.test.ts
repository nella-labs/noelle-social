import { describe, it, expect } from "vitest";
import { ActionableRedditResponseSchema, RedditActivityInSchema, RedditActivityEventSchema, RedditReplyClaimInSchema, RedditReplyClaimOutSchema } from "./reddit-actuator.js";

describe("reddit actuator contracts", () => {
  it("parses a batched activity payload", () => {
    const a = RedditActivityInSchema.parse({
      session_id: "44444444-4444-4444-4444-444444444444",
      events: [
        { type: "reply", approval_id: "11111111-1111-1111-1111-111111111111", comment_id: "d4ef56g", at: "2026-07-17T00:00:00.000Z" },
        { type: "skip", reason: "reply-failed:not-cleared", at: "2026-07-17T00:00:01.000Z" },
      ],
    });
    expect(a.events).toHaveLength(2);
  });

  it("accepts explicit null post_id / comment_id / subreddit (batch-tolerant)", () => {
    // Regression (mirrors the LinkedIn actuator fix): `.optional()` rejected an
    // explicit null → the WHOLE batch 500'd and nothing was inserted (dropping
    // even the reply rows in the same batch). `.nullish()` accepts it — all three
    // columns are nullable text in noelle.reddit_activity.
    const a = RedditActivityInSchema.parse({
      session_id: "44444444-4444-4444-4444-444444444444",
      events: [
        { type: "upvote", post_id: null, subreddit: null, at: "2026-07-17T00:00:00.000Z" },
        { type: "reply", post_id: "1abc23x", comment_id: null, at: "2026-07-17T00:00:01.000Z" },
      ],
    });
    expect(a.events).toHaveLength(2);
    expect(a.events[0]!.post_id).toBeNull();
    expect(a.events[0]!.subreddit).toBeNull();
    expect(a.events[1]!.comment_id).toBeNull();
  });

  it("accepts explicit null approval_id / reason (batch-tolerant)", () => {
    // Mirrors the X activity fix (x-actuator.test.ts): approval_id + reason were
    // `.optional()` too, so an event carrying an explicit JSON `null` for either
    // would make the WHOLE up-to-200-event batch `.parse()` throw — dropping even
    // the reply rows in the same batch. `.nullish()` accepts it; both are nullable
    // text in noelle.reddit_activity.
    const a = RedditActivityInSchema.parse({
      session_id: "44444444-4444-4444-4444-444444444444",
      events: [
        { type: "skip", approval_id: null, reason: null, at: "2026-07-17T00:00:00.000Z" },
        { type: "reply", approval_id: "11111111-1111-1111-1111-111111111111", post_id: "1abc23x", at: "2026-07-17T00:00:01.000Z" },
      ],
    });
    expect(a.events).toHaveLength(2);
    expect(a.events[0]!.approval_id).toBeNull();
    expect(a.events[0]!.reason).toBeNull();
  });

  it("accepts an upvote event with the optional engagement:'save' discriminator", () => {
    // The idle-engagement-variety analog: a save is logged as an "upvote" event
    // (the shared idle-engagement budget) carrying engagement:"save".
    const a = RedditActivityInSchema.parse({
      session_id: "44444444-4444-4444-4444-444444444444",
      events: [
        { type: "upvote", engagement: "save", post_id: "1abc23x", subreddit: "SaaS", at: "2026-07-19T00:00:00.000Z" },
        { type: "upvote", engagement: "upvote", post_id: "1def45y", at: "2026-07-19T00:00:01.000Z" },
      ],
    });
    expect(a.events).toHaveLength(2);
    expect(a.events[0]!.engagement).toBe("save");
    expect(a.events[1]!.engagement).toBe("upvote");
  });

  it("still validates an upvote event WITHOUT engagement (backward-compatible / additive)", () => {
    // The DEFAULT-OFF path never sends the field — an old-shaped upvote event must
    // still parse (a plain upvote), proving the change is purely additive.
    const e = RedditActivityEventSchema.parse({ type: "upvote", post_id: "1abc23x", at: "2026-07-19T00:00:00.000Z" });
    expect(e.engagement).toBeUndefined();
  });

  it("rejects engagement:'downvote' — SAVE-ONLY, the enum is { upvote, save }", () => {
    // The closed enum is the contract-edge guard: a downvote is never a valid idle
    // engagement, so it must fail the batch (mirrors the X actuator's out-of-enum
    // engagement rejection).
    expect(() =>
      RedditActivityInSchema.parse({
        session_id: "44444444-4444-4444-4444-444444444444",
        events: [{ type: "upvote", engagement: "downvote", at: "2026-07-19T00:00:00.000Z" }],
      }),
    ).toThrow();
  });
});

describe("Reddit actionable target identity", () => {
  const url = "https://www.reddit.com/r/SaaS/comments/abc123/title/def456/";
  const target = { type: "comment", url, post_id: "abc123", comment_id: "def456", subreddit: "SaaS", author: null };
  const item = { approval_id: "11111111-1111-4111-8111-111111111111", draft_id: "22222222-2222-4222-8222-222222222222",
    lead_id: "33333333-3333-4333-8333-333333333333", kind: "reply", body: "Measured trace", target };
  it.each([
    ["parent post", { post_id: "other9" }],
    ["comment", { comment_id: "other9" }],
    ["subreddit", { subreddit: "Other" }],
    ["foreign host", { url: url.replace("www.reddit.com", "example.test") }],
    ["deceptive suffix", { url: url.replace("www.reddit.com", "reddit.com.example.test") }],
    ["credentials", { url: url.replace("www.reddit.com", "member@www.reddit.com") }],
    ["port", { url: url.replace("www.reddit.com", "www.reddit.com:8443") }],
    ["control character", { url: `\n${url}` }],
    ["unrelated path", { url: "https://www.reddit.com/redirect/comments/abc123/title/def456/" }],
    ["query text", { url: "https://www.reddit.com/r/SaaS/?next=/comments/abc123/title/def456/" }],
    ["wrong fullname kind", { post_id: "t1_abc123" }],
    ["malformed declared post", { post_id: "abc123!" }],
    ["fullname in URL post path", { url: url.replace("/abc123/", "/t3_abc123/") }],
    ["fullname in URL comment path", { url: url.replace("/def456/", "/t1_def456/") }],
  ])("rejects inconsistent %s before exposing an actionable item", (_, change) => {
    expect(ActionableRedditResponseSchema.safeParse({ replies: [{ ...item, target: { ...target, ...change } }] }).success).toBe(false);
  });
  it("rejects a comment permalink represented as a post target", () => {
    expect(ActionableRedditResponseSchema.safeParse({ replies: [{ ...item, target: { ...target, type: "post" } }] }).success).toBe(false);
  });
  it("normalizes matching fullnames and derives an absent legacy post ID", () => {
    const parsed = ActionableRedditResponseSchema.parse({ replies: [{ ...item,
      target: { ...target, post_id: null, comment_id: "T1_DEF456", subreddit: "r/saas" } }] });
    expect(parsed.replies[0]?.target).toMatchObject({ post_id: "abc123", comment_id: "def456", subreddit: "saas" });
  });
  it.each([
    "https://old.reddit.com/r/SaaS/comments/ABC123/title/DEF456/?context=3#reply",
    "https://new.reddit.com/r/SaaS/comments/abc123/title/def456/",
    "https://www.reddit.com/comments/abc123/title/def456/",
  ])("preserves a coherent comment permalink %s", commentUrl => {
    expect(ActionableRedditResponseSchema.parse({ replies: [{ ...item, target: { ...target, url: commentUrl } }] }).replies).toHaveLength(1);
  });
  it("preserves a matching short post link", () => {
    const parsed = ActionableRedditResponseSchema.parse({ replies: [{ ...item,
      target: { type: "post", url: "https://redd.it/abc123", post_id: "t3_ABC123", subreddit: null, author: null } }] });
    expect(parsed.replies[0]?.target.post_id).toBe("abc123");
  });
});


describe("Reddit pre-submit capture", () => {
  const reply = { approval_id: "11111111-1111-4111-8111-111111111111",
    draft_id: "22222222-2222-4222-8222-222222222222", lead_id: "33333333-3333-4333-8333-333333333333",
    kind: "reply", body: "Measured body", target: { type: "post", url: "https://redd.it/abc123",
      post_id: "abc123", subreddit: null, author: null } };
  const request = { instance_id: "44444444-4444-4444-8444-444444444444", reply };
  it("preserves the original Unicode body and canonical target", () => {
    expect(RedditReplyClaimInSchema.parse({ ...request, reply: { ...reply, body: " Café\r\n測定 " } }).reply.body)
      .toBe(" Café\r\n測定 ");
  });
  it("admits the exact 64 KiB UTF-8 body boundary", () => {
    expect(RedditReplyClaimInSchema.safeParse({ ...request, reply: { ...reply, body: "😀".repeat(16384) } }).success).toBe(true);
  });
  it("rejects one UTF-8 byte beyond the body budget", () => {
    expect(RedditReplyClaimInSchema.safeParse({ ...request, reply: { ...reply, body: "😀".repeat(16384) + "a" } }).success).toBe(false);
  });
  it("rejects a total capture beyond 128 KiB without truncating a target", () => {
    expect(RedditReplyClaimInSchema.safeParse({ ...request, reply: { ...reply,
      target: { ...reply.target, url: "https://www.reddit.com/comments/abc123/" + "a".repeat(131072) } } }).success).toBe(false);
  });
  it.each([{ ...request, instance_id: "invalid" }, { ...request, extra: true },
    { ...request, reply: { ...reply, target: { ...reply.target, post_id: "other" } } }])("rejects an invalid capture", input => {
    expect(RedditReplyClaimInSchema.safeParse(input).success).toBe(false);
  });
  it("requires an explicit successful admission receipt", () => {
    expect(RedditReplyClaimOutSchema.parse({ claimed: true })).toEqual({ claimed: true });
    expect(RedditReplyClaimOutSchema.safeParse({ claimed: false }).success).toBe(false);
    expect(RedditReplyClaimOutSchema.safeParse({ claimed: true, digest: "client" }).success).toBe(false);
  });
});

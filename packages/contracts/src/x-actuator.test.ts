import { describe, it, expect } from "vitest";
import { ActionableXResponseSchema, XActivityInSchema } from "./x-actuator.js";

describe("x-actuator contracts", () => {
  it("parses a valid actionable-x response", () => {
    const r = ActionableXResponseSchema.parse({
      replies: [
        {
          approval_id: "11111111-1111-1111-1111-111111111111",
          draft_id: "22222222-2222-2222-2222-222222222222",
          lead_id: "33333333-3333-3333-3333-333333333333",
          kind: "reply",
          body: "nice thread",
          target: {
            type: "post",
            url: "https://x.com/jackfriks/status/1811234567890123456",
            tweet_id: "1811234567890123456",
            author_handle: "jackfriks",
            author_name: "Jack Friks",
          },
        },
      ],
    });
    expect(r.replies[0]!.kind).toBe("reply");
  });

  it("parses a batched activity payload", () => {
    const a = XActivityInSchema.parse({
      session_id: "44444444-4444-4444-4444-444444444444",
      events: [
        { type: "like", tweet_id: "1", author_handle: "a", at: "2026-07-17T00:00:00.000Z" },
        { type: "skip", reason: "reply-failed:not-cleared", tweet_id: "2", at: "2026-07-17T00:00:01.000Z" },
      ],
    });
    expect(a.events).toHaveLength(2);
  });

  it("accepts explicit null tweet_id / author_handle (like with no resolvable id)", () => {
    // Regression mirror of the LinkedIn activity batch-500 fix: an event carrying
    // an explicit JSON `null` (instead of omitting the field) must not make the
    // WHOLE up-to-200-event batch throw — one unresolvable id would otherwise
    // silently drop every row (including the reply rows dedup/caps read back).
    const a = XActivityInSchema.parse({
      session_id: "44444444-4444-4444-4444-444444444444",
      events: [
        { type: "like", tweet_id: null, author_handle: null, at: "2026-07-17T00:00:00.000Z" },
        { type: "skip", reason: null, approval_id: null, at: "2026-07-17T00:00:01.000Z" },
        { type: "reply", tweet_id: "3", at: "2026-07-17T00:00:02.000Z" },
      ],
    });
    expect(a.events).toHaveLength(3);
    expect(a.events[0]!.tweet_id).toBeNull();
    expect(a.events[0]!.author_handle).toBeNull();
    expect(a.events[1]!.reason).toBeNull();
  });

  it("rejects a reply item with a non-post target shape", () => {
    // XPostTargetSchema pins type to the literal "post"; the reply-only X actuator
    // queue never carries a profile/DM target (mirrors the LinkedIn contract's
    // type=profile rejection). A bad target must fail the whole response parse.
    expect(() =>
      ActionableXResponseSchema.parse({
        replies: [
          {
            approval_id: "11111111-1111-1111-1111-111111111111",
            draft_id: "22222222-2222-2222-2222-222222222222",
            lead_id: "33333333-3333-3333-3333-333333333333",
            kind: "reply",
            body: "x",
            target: {
              type: "profile",
              url: "https://x.com/jackfriks",
              tweet_id: null,
              author_handle: null,
              author_name: null,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a reply item whose target url is not a URL", () => {
    // url is z.string().url() — a bare handle / non-URL is not a tweet permalink
    // the actuator could ever open, so it must be rejected at the contract edge.
    expect(() =>
      ActionableXResponseSchema.parse({
        replies: [
          {
            approval_id: "11111111-1111-1111-1111-111111111111",
            draft_id: "22222222-2222-2222-2222-222222222222",
            lead_id: "33333333-3333-3333-3333-333333333333",
            kind: "reply",
            body: "x",
            target: {
              type: "post",
              url: "not-a-url",
              tweet_id: "1811234567890123456",
              author_handle: "jackfriks",
              author_name: "Jack Friks",
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a reply item with an empty body", () => {
    // body is z.string().min(1) — an empty reply must never reach the actuator
    // (it would post a blank reply / fail the composer).
    expect(() =>
      ActionableXResponseSchema.parse({
        replies: [
          {
            approval_id: "11111111-1111-1111-1111-111111111111",
            draft_id: "22222222-2222-2222-2222-222222222222",
            lead_id: "33333333-3333-3333-3333-333333333333",
            kind: "reply",
            body: "",
            target: {
              type: "post",
              url: "https://x.com/jackfriks/status/1811234567890123456",
              tweet_id: "1811234567890123456",
              author_handle: "jackfriks",
              author_name: "Jack Friks",
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an activity event with an out-of-enum engagement value", () => {
    // engagement is z.enum(["like","bookmark","repost"]).nullish() — "quote" is not
    // one of them. repost is the only public amplification the actuator ever
    // delivers, so the closed enum is the guard against an unknown write class.
    expect(() =>
      XActivityInSchema.parse({
        session_id: "44444444-4444-4444-4444-444444444444",
        events: [
          { type: "like", tweet_id: "1", engagement: "quote", at: "2026-07-17T00:00:00.000Z" },
        ],
      }),
    ).toThrow();
  });

  it("rejects an activity event with an unknown type", () => {
    // type is z.enum(["like","reply","skip"]); a "dm" event has no place in the
    // X activity stream (X DMs are never auto-sent) and must fail the batch.
    expect(() =>
      XActivityInSchema.parse({
        session_id: "44444444-4444-4444-4444-444444444444",
        events: [{ type: "dm", tweet_id: "1", at: "2026-07-17T00:00:00.000Z" }],
      }),
    ).toThrow();
  });

  it("rejects an empty events array (a batch must carry at least one event)", () => {
    // events is .min(1).max(200) — an empty batch is a malformed post, not a no-op.
    expect(() =>
      XActivityInSchema.parse({
        session_id: "44444444-4444-4444-4444-444444444444",
        events: [],
      }),
    ).toThrow();
  });
});

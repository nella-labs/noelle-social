import { describe, it, expect } from "vitest";
import { InboundReplyInSchema, InboundReplyResponseSchema } from "@noelle/contracts";
import { conversationKeyFor, dedupeAlreadyCommented, resolveNotificationMaxTurns } from "./actuator.js";

describe("resolveNotificationMaxTurns", () => {
  it("defaults to 2 turns", () => {
    expect(resolveNotificationMaxTurns(undefined)).toBe(2);
  });

  it("accepts an override", () => {
    expect(resolveNotificationMaxTurns("4")).toBe(4);
  });

  it("accepts 0 — the kill switch for the whole ingest", () => {
    expect(resolveNotificationMaxTurns("0")).toBe(0);
  });

  it("falls back to the default on junk", () => {
    expect(resolveNotificationMaxTurns("many")).toBe(2);
    expect(resolveNotificationMaxTurns("-3")).toBe(2);
    expect(resolveNotificationMaxTurns("")).toBe(2);
    expect(resolveNotificationMaxTurns("1e30")).toBe(2);
  });

  it("floors a fractional override", () => {
    expect(resolveNotificationMaxTurns("2.9")).toBe(2);
  });
});

describe("conversationKeyFor", () => {
  it("keys on the thread root when the sweep could read it", () => {
    expect(
      conversationKeyFor({ author_handle: "alice", conversation: { root_post_id: "100" } }),
    ).toBe("root:100");
  });

  it("collapses every reply in one thread onto the same key", () => {
    const a = conversationKeyFor({ author_handle: "alice", conversation: { root_post_id: "100" } });
    const b = conversationKeyFor({ author_handle: "bob", conversation: { root_post_id: "100" } });
    expect(a).toBe(b);
  });

  it("falls back to the person when the root is unknown, so it still can't loop", () => {
    expect(conversationKeyFor({ author_handle: "Alice" })).toBe("author:alice");
    expect(conversationKeyFor({ author_handle: "alice", conversation: null })).toBe("author:alice");
    expect(
      conversationKeyFor({ author_handle: "alice", conversation: { root_post_id: "  " } }),
    ).toBe("author:alice");
  });
});

describe("InboundReplyInSchema", () => {
  const item = {
    external_id: "300",
    author_handle: "alice",
    text: "disagree, here's why",
    url: "https://x.com/alice/status/300",
    posted_at: "2026-07-26T10:00:00.000Z",
  };

  it("accepts a minimal item", () => {
    expect(() =>
      InboundReplyInSchema.parse({
        instanceId: "11111111-1111-4111-8111-111111111111",
        platform: "x",
        items: [item],
      }),
    ).not.toThrow();
  });

  it("accepts the conversation context", () => {
    const parsed = InboundReplyInSchema.parse({
      instanceId: "11111111-1111-4111-8111-111111111111",
      platform: "linkedin",
      items: [{ ...item, conversation: { root_post_id: "100", root_post_text: "hi", our_reply_text: "yo" } }],
    });
    expect(parsed.items[0]!.conversation?.root_post_id).toBe("100");
  });

  it("rejects an empty batch", () => {
    expect(() =>
      InboundReplyInSchema.parse({
        instanceId: "11111111-1111-4111-8111-111111111111",
        platform: "x",
        items: [],
      }),
    ).toThrow();
  });

  it("bounds the batch so one sweep can't flood the drafting queue", () => {
    expect(() =>
      InboundReplyInSchema.parse({
        instanceId: "11111111-1111-4111-8111-111111111111",
        platform: "x",
        items: Array.from({ length: 51 }, (_, i) => ({ ...item, external_id: String(i) })),
      }),
    ).toThrow();
  });

  it("rejects a non-URL permalink", () => {
    expect(() =>
      InboundReplyInSchema.parse({
        instanceId: "11111111-1111-4111-8111-111111111111",
        platform: "x",
        items: [{ ...item, url: "not-a-url" }],
      }),
    ).toThrow();
  });

  it("rejects a non-ISO timestamp", () => {
    expect(() =>
      InboundReplyInSchema.parse({
        instanceId: "11111111-1111-4111-8111-111111111111",
        platform: "x",
        items: [{ ...item, posted_at: "yesterday" }],
      }),
    ).toThrow();
  });

  it("rejects an unsupported platform (reddit auto-sends; it has no notifications lane)", () => {
    expect(() =>
      InboundReplyInSchema.parse({
        instanceId: "11111111-1111-4111-8111-111111111111",
        platform: "reddit",
        items: [item],
      }),
    ).toThrow();
  });
});

describe("InboundReplyResponseSchema", () => {
  it("round-trips a mixed result set", () => {
    const parsed = InboundReplyResponseSchema.parse({
      accepted: 1,
      skipped: 2,
      results: [
        { external_id: "1", accepted: true },
        { external_id: "2", accepted: false, reason: "duplicate" },
        { external_id: "3", accepted: false, reason: "turn-cap" },
      ],
    });
    expect(parsed.accepted).toBe(1);
    expect(parsed.results.filter((r) => !r.accepted)).toHaveLength(2);
  });

  it("rejects an unknown skip reason", () => {
    expect(() =>
      InboundReplyResponseSchema.parse({
        accepted: 0,
        skipped: 1,
        results: [{ external_id: "1", accepted: false, reason: "vibes" }],
      }),
    ).toThrow();
  });
});

// The LinkedIn already-commented dedup is what stops two leads producing two
// comments on one post. A conversation reply IS a second comment on a post we
// already commented on — by design — so without the lead-id exemption every
// LinkedIn conversation reply is silently dropped and the feature does nothing.
describe("dedupeAlreadyCommented conversation exemption", () => {
  const comment = (leadId: string, urn: string) => ({
    approval_id: "a-" + leadId,
    draft_id: "d-" + leadId,
    lead_id: leadId,
    kind: "reply" as const,
    body: "sure",
    target: { type: "post" as const, url: "https://www.linkedin.com/feed/update/" + urn + "/", activity_urn: urn, author_name: "Alice" },
  });
  const urn = "urn:li:activity:7300000000000000000";
  const built = { comments: [comment("lead-1", urn)], dms: [] };

  it("still drops an ordinary re-comment on an already-commented post", () => {
    expect(dedupeAlreadyCommented(built, new Set([urn])).comments).toHaveLength(0);
  });

  it("keeps a notification-sourced lead on that same post", () => {
    expect(
      dedupeAlreadyCommented(built, new Set([urn]), new Set(["lead-1"])).comments,
    ).toHaveLength(1);
  });

  it("exempts by lead id, never by post — a stale sibling lead still drops", () => {
    const two = { comments: [comment("lead-1", urn), comment("lead-2", urn)], dms: [] };
    const kept = dedupeAlreadyCommented(two, new Set([urn]), new Set(["lead-1"])).comments;
    expect(kept.map((c) => c.lead_id)).toEqual(["lead-1"]);
  });

  it("is a no-op when nothing has been commented on yet", () => {
    expect(dedupeAlreadyCommented(built, new Set()).comments).toHaveLength(1);
  });

  it("omitting the exemption argument behaves exactly as before", () => {
    expect(dedupeAlreadyCommented(built, new Set([urn]))).toEqual(
      dedupeAlreadyCommented(built, new Set([urn]), new Set()),
    );
  });
});

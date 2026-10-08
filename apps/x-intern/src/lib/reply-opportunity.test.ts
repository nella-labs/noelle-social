import { describe, expect, it } from "vitest";
import { replyConversationId, scoreReplyOpportunity, selectReplyOpportunities } from "./reply-opportunity.js";

const now = new Date("2026-10-05T18:00:00Z");
const candidate = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, external_id: id, author_handle: `author-${id}`, classifier_score: 0.9,
  payload: { posted_at: "2026-10-05T17:00:00Z", likeCount: 2 },
  ...overrides,
});

describe("reply opportunities", () => {
  it("keeps classification as evidence and labels the combined score as a heuristic", () => {
    const score = scoreReplyOpportunity(candidate("1"), now, 0);
    expect(score).toMatchObject({ version: 1, quality: 0.9, age_hours: 1, trending: false });
    expect(score.score).toBeGreaterThan(0);
    expect(score).not.toHaveProperty("probability");
  });

  it("keeps high qualification ahead of a weak viral candidate", () => {
    const picked = selectReplyOpportunities([
      candidate("1", { classifier_score: 0.36, payload: { posted_at: now.toISOString(), likeCount: 10_000 } }),
      candidate("2", { classifier_score: 0.94, payload: { posted_at: "2026-10-05T14:00:00Z", likeCount: 50 } }),
    ], { now, slots: 1, trendNeed: 1 });
    expect(picked.map((p) => p.id)).toEqual(["2"]);
  });

  it("favors fresher equally qualified posts and softly reduces repeated authors", () => {
    const old = scoreReplyOpportunity(candidate("1", { payload: { posted_at: "2026-10-02T18:00:00Z" } }), now, 0);
    const fresh = scoreReplyOpportunity(candidate("2"), now, 0);
    const repeated = scoreReplyOpportunity(candidate("2"), now, 3);
    expect(fresh.score).toBeGreaterThan(old.score);
    expect(fresh.score).toBeGreaterThan(repeated.score);
    expect(repeated.score).toBeGreaterThan(0);
    expect(repeated.recent_author_replies).toBe(3);
  });

  it("handles malformed metrics, missing and far-future timestamps without invented momentum", () => {
    const score = scoreReplyOpportunity(candidate("1", {
      classifier_score: "NaN", payload: { posted_at: "2026-13-90", likeCount: "junk", replyCount: -3 },
    }), now, 0);
    expect(score).toMatchObject({ quality: null, age_hours: null, momentum: null, trending: false });
    const future = scoreReplyOpportunity(candidate("2", {
      payload: { posted_at: "2027-10-05T18:00:00Z", likeCount: 10_000 },
    }), now, 0);
    expect(future.age_hours).toBeNull();
    expect(future.trending).toBe(false);
    expect(Number.isFinite(score.score)).toBe(true);
  });

  it("does not reward numeric strings, unsafe integers or unknown engagement", () => {
    const score = scoreReplyOpportunity(candidate("1", {
      payload: { posted_at: now.toISOString(), likeCount: "10000", replyCount: Number.MAX_VALUE },
    }), now, 0);
    expect(score.momentum).toBeNull();
    expect(score.trending).toBe(false);
  });

  it.each(["2026-02-30T12:00:00Z", "2026-10-05", "now", "2026-10-05T25:00:00Z"])(
    "does not invent a post time from %s", (postedAt) => {
      expect(scoreReplyOpportunity(candidate("1", { payload: { posted_at: postedAt } }), now, 0)
        .age_hours).toBeNull();
    },
  );

  it("reserves trending slots and fills the rest from normal supply", () => {
    const candidates = Array.from({ length: 14 }, (_, i) => candidate(String(i + 1), {
      payload: { posted_at: now.toISOString(), likeCount: i < 8 ? 100 : 2 },
    }));
    const picked = selectReplyOpportunities(candidates, { now, slots: 12, trendNeed: 7 });
    expect(picked).toHaveLength(12);
    expect(picked.filter((p) => p.opportunity.trending)).toHaveLength(7);
  });

  it("deduplicates normalized authors and known conversations before choosing slots", () => {
    const picked = selectReplyOpportunities([
      candidate("1", { author_handle: "@Ada", payload: { conversation_id: "500", posted_at: "2026-10-05T16:00:00Z" } }),
      candidate("2", { author_handle: "ada", payload: { conversation: { root_post_id: "600" }, posted_at: now.toISOString() } }),
      candidate("3", { payload: { conversationId: "600", posted_at: now.toISOString() } }),
      candidate("4"),
    ], { now, slots: 12, trendNeed: 7 });
    expect(picked.map((p) => p.id)).toEqual(["2", "4"]);
    expect(replyConversationId({ conversation_id: "broken" })).toBeNull();
  });

  it.each(["0", "0000"])("does not identify the all-zero sentinel %s as a shared thread", id => {
    expect(replyConversationId({ conversation_id: id })).toBeNull();
  });

  it.each([{}, "invalid", "0"])("uses a valid thread alias after malformed primary %j", primary => {
    expect(replyConversationId({ conversation_id: primary, conversationId: "500" })).toBe("500");
  });

  it("keeps different authors available when their saved thread is an unknown sentinel", () => {
    const picked = selectReplyOpportunities([
      candidate("1", { payload: { conversation_id: "0" } }),
      candidate("2", { payload: { conversation_id: "0" } }),
    ], { now, slots: 2, trendNeed: 0 });
    expect(picked.map(item => item.id)).toEqual(["1", "2"]);
  });

  it("preserves the trending reserve after collapsing a repeated conversation", () => {
    const candidates = Array.from({ length: 14 }, (_, i) => candidate(String(i + 1), {
      payload: { posted_at: now.toISOString(), likeCount: i < 8 ? 100 : 2,
        ...(i < 2 ? { conversation_id: "500" } : {}) },
    }));
    const picked = selectReplyOpportunities(candidates, { now, slots: 12, trendNeed: 7 });
    expect(picked).toHaveLength(12);
    expect(picked.filter((p) => p.opportunity.trending)).toHaveLength(7);
  });

  it("excludes already occupied authors, exact targets and known conversation roots", () => {
    const picked = selectReplyOpportunities([
      candidate("1"), candidate("2"), candidate("3", { payload: { root_post_id: "500" } }), candidate("4"),
    ], { now, slots: 12, trendNeed: 7, occupiedAuthors: new Set(["author-1"]),
      blockedTargets: new Set(["2"]), blockedConversations: new Set(["500"]) });
    expect(picked.map((p) => p.id)).toEqual(["4"]);
  });
});

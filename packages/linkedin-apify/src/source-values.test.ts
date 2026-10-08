import { describe, expect, it } from "vitest";
import { createApifyLinkedInClient, normalizeAuthoredComment, normalizeComment, normalizePost } from "./index.js";

const post = { id: "123456", content: "A saved post" };
const comment = { id: "c1", commentary: "A saved comment" };

function clientWith(items: unknown[]) {
  let input: Record<string, unknown> = {};
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      input = JSON.parse(String(init.body));
      return Response.json({ data: { id: "run_1", status: "SUCCEEDED", defaultDatasetId: "data_1" } });
    }
    return Response.json(items);
  }) as typeof fetch;
  return { client: createApifyLinkedInClient({ token: "test", fetchImpl }), input: () => input };
}

describe("LinkedIn source count measurements", () => {
  it.each(["", " ", "unknown", 1.5, -1, Number.MAX_SAFE_INTEGER + 1, Infinity, null, undefined])(
    "keeps malformed post/comment count %j unknown", value => {
      const p = normalizePost({ ...post, engagement: { likes: value, comments: value } })!;
      expect([p.reactions, p.comments]).toEqual([null, null]);
      const c = normalizeComment({ ...comment, numComments: value, reactionTypeCounts: [{ count: value }] })!;
      expect([c.reactions, c.repliesCount]).toEqual([null, null]);
      const authored = normalizeAuthoredComment({ ...comment, engagement: { likes: value, comments: value } })!;
      expect([authored.reactions, authored.repliesCount]).toEqual([null, null]);
    },
  );

  it.each([0, "0", 12, "12"])("preserves measured count %j", value => {
    const p = normalizePost({ ...post, engagement: { likes: value, comments: value } })!;
    expect([p.reactions, p.comments]).toEqual([Number(value), Number(value)]);
  });

  it("does not present a partial or overflowing reaction breakdown as a total", () => {
    for (const counts of [[3, "unknown"], [Number.MAX_SAFE_INTEGER, 1]]) {
      const reactions = counts.map(count => ({ count }));
      expect(normalizeComment({ ...comment, reactionTypeCounts: reactions })!.reactions).toBeNull();
      expect(normalizeAuthoredComment({ ...comment, engagement: { reactions, likes: 99 } })!.reactions).toBeNull();
    }
  });

  it("preserves a measured empty breakdown and valid per-type sums", () => {
    expect(normalizeComment({ ...comment, reactionTypeCounts: [] })!.reactions).toBe(0);
    expect(normalizeAuthoredComment({ ...comment, engagement: { reactions: [{ count: 2 }, { count: "3" }] } })!.reactions).toBe(5);
  });
});

describe("LinkedIn source timestamps", () => {
  it.each(["2026-02-30T12:00:00Z", "2025-02-29T00:00:00Z", "", "unknown"])(
    "keeps impossible/missing source date %j unknown", date => {
      expect(normalizePost({ ...post, postedAt: { date } })!.postedAt).toBeNull();
      expect(normalizeComment({ ...comment, createdAt: date })!.createdAt).toBeNull();
      expect(normalizeAuthoredComment({ ...comment, createdAt: date })!.createdAt).toBeNull();
    },
  );

  it.each([0, 1000, 1780000000000])("uses the documented millisecond unit for epoch %j", epoch => {
    const iso = new Date(epoch).toISOString();
    expect(normalizePost({ ...post, postedAt: { timestamp: epoch } })!.postedAt).toBe(iso);
    expect(normalizeComment({ ...comment, createdAt: epoch })!.createdAt).toBe(iso);
    expect(normalizeAuthoredComment({ ...comment, createdAtTimestamp: epoch })!.createdAt).toBe(iso);
  });

  it.each([Number.MAX_VALUE, 1.5, Infinity])("keeps unusable epoch %j unknown without throwing", epoch => {
    expect(normalizePost({ ...post, postedAt: { timestamp: epoch } })!.postedAt).toBeNull();
    expect(normalizeComment({ ...comment, createdAt: epoch })!.createdAt).toBeNull();
    expect(normalizeAuthoredComment({ ...comment, createdAtTimestamp: epoch })!.createdAt).toBeNull();
  });

  it("canonicalizes valid offset dates and permits a valid alternate source field", () => {
    const date = "2026-06-15T12:30:00+03:00";
    expect(normalizePost({ ...post, postedAt: { date } })!.postedAt).toBe("2026-06-15T09:30:00.000Z");
    expect(normalizeAuthoredComment({ ...comment, createdAt: "2026-02-30T00:00:00Z", createdAtTimestamp: 1000 })!.createdAt).toBe("1970-01-01T00:00:01.000Z");
  });
});

describe("validated LinkedIn recency floors", () => {
  it("omits an impossible actor floor and preserves valid posts it would wrongly discard", async () => {
    const h = clientWith([{ ...post, postedAt: { date: "2026-03-01T00:00:00Z" } }]);
    expect(await h.client.profilePosts({ publicId: "person", sinceISO: "2026-02-30T00:00:00Z" })).toHaveLength(1);
    expect(h.input()).not.toHaveProperty("postedLimitDate");
  });

  it("does not invent a coarse actor window from an impossible authored-comment floor", async () => {
    const h = clientWith([{ ...comment, createdAt: "2026-03-01T00:00:00Z" }]);
    expect(await h.client.authoredComments({ publicId: "person", sinceISO: "2026-02-30T00:00:00Z" })).toHaveLength(1);
    expect(h.input()).not.toHaveProperty("postedLimit");
  });

  it("normalizes unknown item dates before precise filtering, with valid dates still excluded", async () => {
    const h = clientWith([
      { ...post, postedAt: { date: "2026-02-30T00:00:00Z" } },
      { ...post, id: "123457", postedAt: { date: "2026-03-01T00:00:00Z" } },
    ]);
    const rows = await h.client.searchPosts({ queries: ["topic"], sinceISO: "2026-03-03T00:00:00Z" });
    expect(rows.map(row => [row.id, row.postedAt])).toEqual([["123456", null]]);
  });
});

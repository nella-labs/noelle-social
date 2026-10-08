import { describe, expect, it } from "vitest";
import { fetchRedditPostComments } from "./index.js";

function comment(kind: string, data: Record<string, unknown>) {
  return { kind, data };
}

function makeFetch(body: unknown, ok = true, status = 200) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const LISTING = [
  { kind: "Listing", data: {} }, // [0] the post itself
  {
    kind: "Listing",
    data: {
      children: [
        comment("t1", { author: "alice", body: "the retry backoff fixed the p99", score: 10 }),
        comment("t1", { author: "bob", body: "top voice in the room", score: 50 }),
        comment("t1", { author: "AutoModerator", body: "read the rules", score: 5 }),
        comment("t1", { author: "carol", body: "[deleted]", score: 3 }),
        comment("t1", { author: "dave", body: "pinned mod note", score: 2, stickied: true }),
        comment("more", { count: 20 }),
      ],
    },
  },
];

describe("fetchRedditPostComments", () => {
  it("preserves negative/zero votes and sorts unknown scores last without inventing zero", async () => {
    const { fetchImpl } = makeFetch([{}, { data: { children: [
      comment("t1", { author: "unknown1", body: "first unknown", score: "" }),
      comment("t1", { author: "negative", body: "measured negative", score: -2 }),
      comment("t1", { author: "unknown2", body: "second unknown", score: 1.5 }),
      comment("t1", { author: "zero", body: "measured zero", score: 0 }),
    ] } }]);
    const out = await fetchRedditPostComments({ postId: "abc123", fetchImpl });
    expect(out.map(c => c.score)).toEqual([0, -2, null, null]);
    expect(out.map(c => c.author)).toEqual(["u/zero", "u/negative", "u/unknown1", "u/unknown2"]);
  });

  it("returns top-level comments ranked by score, filtering noise", async () => {
    const { fetchImpl, calls } = makeFetch(LISTING);
    const out = await fetchRedditPostComments({ postId: "abc123", limit: 5, fetchImpl });
    expect(out.map((c) => c.author)).toEqual(["u/bob", "u/alice"]); // 50 before 10
    expect(out.map((c) => c.body)).toEqual([
      "top voice in the room",
      "the retry backoff fixed the p99",
    ]);
    // AutoModerator, [deleted], stickied, and "more" nodes are all dropped.
    expect(out).toHaveLength(2);
    expect(calls[0]).toContain("/comments/abc123.json");
    expect(calls[0]).toContain("sort=top");
  });

  it("strips a t3_ prefix from the post id", async () => {
    const { fetchImpl, calls } = makeFetch(LISTING);
    await fetchRedditPostComments({ postId: "t3_abc123", fetchImpl });
    expect(calls[0]).toContain("/comments/abc123.json");
  });

  it("fails open (returns []) on a non-200", async () => {
    const { fetchImpl } = makeFetch("rate limited", false, 429);
    expect(await fetchRedditPostComments({ postId: "abc123", fetchImpl })).toEqual([]);
  });

  it("fails open on an unexpected shape", async () => {
    const { fetchImpl } = makeFetch({ not: "an array" });
    expect(await fetchRedditPostComments({ postId: "abc123", fetchImpl })).toEqual([]);
  });

  it("fails open on a network error", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await fetchRedditPostComments({ postId: "abc123", fetchImpl })).toEqual([]);
  });

  it("returns [] without fetching for a blank post id", async () => {
    const { fetchImpl, calls } = makeFetch(LISTING);
    expect(await fetchRedditPostComments({ postId: "  ", fetchImpl })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

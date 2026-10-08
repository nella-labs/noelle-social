import { describe, expect, it } from "vitest";
import { createApifyXClient, normalizeTweet } from "./index.js";

const tweet = { id: "123", text: "A supported observation", createdAt: "2026-10-05T10:00:00Z",
  author: { userName: "builder", followers: 100 } };

describe("untrusted discovery normalization", () => {
  it.each([null, undefined, [], "tweet", 42, { ...tweet, text: 7 },
    { ...tweet, author: { userName: 7 } }, { ...tweet, id: {} },
    { ...tweet, id: 1799999999999999999 }])("drops malformed or imprecise identity %j without throwing", (item) => {
    expect(normalizeTweet(item as never)).toBeNull();
  });

  it.each(["", "  ", -1, "-2", false, Infinity, Number.NaN])(
    "keeps invalid counts unknown for %j", (value) => {
      const normalized = normalizeTweet({ ...tweet, likeCount: value, replyCount: value,
        author: { ...tweet.author, followers: value } });
      expect(normalized).toMatchObject({ likes: null, replies: null, author: { followers: null } });
    });

  it("uses a valid alternate count when an earlier spelling is blank", () => {
    expect(normalizeTweet({ ...tweet, likeCount: " ", favorite_count: "12" })?.likes).toBe(12);
  });

  it("preserves measured zero and leaves fractional counts unknown", () => {
    expect(normalizeTweet({ ...tweet, likeCount: "0", replyCount: 2.9 })).toMatchObject({ likes: 0, replies: null });
  });

  it("ignores malformed media collections, entries and non-HTTP URLs", () => {
    expect(normalizeTweet({ ...tweet, extendedEntities: { media: {} }, entities: { media: [null, 1] },
      media: [null, false, "httpjunk", "javascript:alert(1)", { media_url_https: 7 },
        { media_url_https: "https://pbs.twimg.com/a.jpg" }, "https://pbs.twimg.com/a.jpg"] } as never)?.images)
      .toEqual(["https://pbs.twimg.com/a.jpg"]);
  });

  it("uses a canonical post URL when the actor URL is not a usable string", () => {
    expect(normalizeTweet({ ...tweet, url: {} } as never)?.url).toBe("https://x.com/builder/status/123");
  });

  it("retains numeric thread and parent identifiers without coercing unknown data", () => {
    expect(normalizeTweet({ ...tweet, conversationId: "100", inReplyToId: "101" }))
      .toMatchObject({ conversation_id: "100", in_reply_to_id: "101", is_reply: true });
    expect(normalizeTweet({ ...tweet, conversationId: {} } as never))
      .toMatchObject({ is_reply: false });
    expect(normalizeTweet({ ...tweet, conversationId: {} } as never)?.conversation_id).toBeUndefined();
  });

  it("keeps usable paid results when a dataset includes malformed rows", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/datasets/") ? [null, { ...tweet, text: 7 }, tweet]
        : { data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }), { status: 200 })) as typeof fetch;
    const result = await createApifyXClient({ token: "test", fetchImpl }).userTweets({ handle: "builder", limit: 10 });
    expect(result.tweets.map((item) => item.id)).toEqual(["123"]);
    expect(result.resultCount).toBe(3);
  });
});

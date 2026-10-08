import { describe, expect, it } from "vitest";
import {
  createApifyXClient,
  normalizeTweet,
  checkApifyToken,
  ApifyXError,
  X_SCRAPER_ACTOR_ID,
} from "./index.js";

// One item from the kaito twitter-x-data-tweet-scraper dataset (subset of fields).
const SAMPLE = {
  id: "1799999999999999999",
  url: "https://x.com/devbuilder/status/1799999999999999999",
  text: "shipping the agent org-chart today. replies are the unit of growth.",
  createdAt: "Wed Jun 18 14:03:12 +0000 2025",
  isRetweet: false,
  author: {
    userName: "devbuilder",
    id: "44196397",
    name: "Dev Builder",
    followers: 8421,
  },
};

/**
 * Simulates Apify's async run flow the client now uses: POST /v2/acts/{id}/runs
 * (returns the run object, where token-fatal errors surface), an optional poll of
 * GET /v2/actor-runs/{id} while the run is non-terminal, then GET
 * /v2/datasets/{id}/items for the results. The handler returns { status, items,
 * text, usageTotalUsd, runStatus } — usageTotalUsd is the real per-run cost the run
 * reports; runStatus forces a terminal failure or "RUNNING" (one poll before success).
 */
function harness(
  handler: (
    url: string,
    body: Record<string, unknown>,
  ) => { status?: number; items?: unknown[]; text?: string; usageTotalUsd?: number; runStatus?: string },
) {
  let startUrl = "";
  let lastUrl = "";
  let lastBody: Record<string, unknown> = {};
  const runObj = (status: string, usageTotalUsd: number | undefined) =>
    new Response(
      JSON.stringify({ data: { id: "run_test", status, usageTotalUsd, defaultDatasetId: "ds_test" } }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    lastUrl = url;
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/runs")) {
      startUrl = url;
      lastBody = init?.body ? JSON.parse(init.body as string) : {};
      const r = handler(url, lastBody);
      if ((r.status ?? 200) >= 400) return new Response(r.text ?? "error", { status: r.status });
      return runObj(r.runStatus ?? "SUCCEEDED", r.usageTotalUsd);
    }
    if (method === "GET" && url.includes("/actor-runs/")) {
      // Poll: the run is now terminal (SUCCEEDED unless the test forced a failure).
      const r = handler(url, lastBody);
      const status = r.runStatus && r.runStatus !== "RUNNING" && r.runStatus !== "READY" ? r.runStatus : "SUCCEEDED";
      return runObj(status, r.usageTotalUsd);
    }
    if (method === "GET" && url.includes("/datasets/")) {
      const r = handler(url, lastBody);
      return new Response(JSON.stringify(r.items ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = createApifyXClient({ token: "tok-123", fetchImpl, timeoutMs: 4000 });
  return { client, url: () => lastUrl, startUrl: () => startUrl, body: () => lastBody };
}

describe("normalizeTweet", () => {
  it("maps the actor item onto the XTweet shape, followers included", () => {
    const t = normalizeTweet(SAMPLE);
    expect(t).not.toBeNull();
    expect(t!.id).toBe("1799999999999999999");
    expect(t!.text).toContain("agent org-chart");
    expect(t!.author.handle).toBe("devbuilder");
    expect(t!.author.id).toBe("44196397");
    expect(t!.author.followers).toBe(8421);
    expect(t!.url).toBe("https://x.com/devbuilder/status/1799999999999999999");
    // Twitter's native createdAt is normalised to ISO.
    expect(t!.created_at).toBe(new Date("Wed Jun 18 14:03:12 +0000 2025").toISOString());
  });

  it("synthesises the url from handle + id when the actor omits it", () => {
    const t = normalizeTweet({ ...SAMPLE, url: undefined, twitterUrl: undefined });
    expect(t!.url).toBe("https://x.com/devbuilder/status/1799999999999999999");
  });

  it("returns null for an undateable tweet (no fabricated timestamp)", () => {
    expect(normalizeTweet({ ...SAMPLE, createdAt: undefined })).toBeNull();
    expect(normalizeTweet({ ...SAMPLE, createdAt: "not a date" })).toBeNull();
  });

  it("returns null when id, text, or handle is missing", () => {
    expect(normalizeTweet({ ...SAMPLE, id: undefined })).toBeNull();
    expect(normalizeTweet({ ...SAMPLE, text: "  " })).toBeNull();
    expect(normalizeTweet({ ...SAMPLE, author: { userName: undefined } })).toBeNull();
  });

  it("flags native retweets as reposts; quote/plain tweets stay false", () => {
    expect(normalizeTweet({ ...SAMPLE, isRetweet: true })!.is_repost).toBe(true);
    // kaito has no isRetweet flag — it populates retweeted_tweet instead.
    expect(normalizeTweet({ ...SAMPLE, retweeted_tweet: { id: "9" } })!.is_repost).toBe(true);
    expect(normalizeTweet(SAMPLE)!.is_repost).toBe(false);
  });

  it("flags replies via explicit flags, an in-reply-to id, or conversationId != id", () => {
    // A plain top-level post is not a reply; its conversationId equals its id.
    expect(normalizeTweet(SAMPLE)!.is_reply).toBe(false);
    expect(normalizeTweet({ ...SAMPLE, conversationId: SAMPLE.id })!.is_reply).toBe(false);
    // Explicit isReply flag.
    expect(normalizeTweet({ ...SAMPLE, isReply: true })!.is_reply).toBe(true);
    // An in-reply-to id under any of the supported field names.
    expect(normalizeTweet({ ...SAMPLE, inReplyToId: "12345" })!.is_reply).toBe(true);
    expect(normalizeTweet({ ...SAMPLE, in_reply_to_status_id_str: "12345" })!.is_reply).toBe(true);
    // conversationId pointing at a DIFFERENT (earlier) tweet = a reply in a thread.
    expect(normalizeTweet({ ...SAMPLE, conversationId: "1700000000000000000" })!.is_reply).toBe(true);
  });

  it("drops kaito demo/mock placeholders (type:'mock_tweet' or demo:true)", () => {
    expect(normalizeTweet({ ...SAMPLE, type: "mock_tweet" })).toBeNull();
    expect(normalizeTweet({ demo: true } as any)).toBeNull();
    // A real post is type:"tweet"; items with no type at all still pass.
    expect(normalizeTweet({ ...SAMPLE, type: "tweet" })).not.toBeNull();
    expect(normalizeTweet(SAMPLE)).not.toBeNull();
  });

  it("extracts media image urls defensively, omitting the field when none", () => {
    const withMedia = normalizeTweet({
      ...SAMPLE,
      extendedEntities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/a.jpg" }] },
    });
    expect(withMedia!.images).toEqual(["https://pbs.twimg.com/a.jpg"]);
    expect(normalizeTweet(SAMPLE)!.images).toBeUndefined();
  });

  it("maps engagement counts across actor key/casing variants", () => {
    // kaito casing
    const kaito = normalizeTweet({ ...SAMPLE, likeCount: 234, retweetCount: 12, replyCount: 5 });
    expect(kaito!.likes).toBe(234);
    expect(kaito!.reposts).toBe(12);
    expect(kaito!.replies).toBe(5);
    // snake_case + flat `likes` fallback, string numbers coerced
    const apidojo = normalizeTweet({ ...SAMPLE, favorite_count: "99", retweet_count: "3", reply_count: 1 });
    expect(apidojo!.likes).toBe(99);
    expect(apidojo!.reposts).toBe(3);
    expect(apidojo!.replies).toBe(1);
  });

  it("leaves engagement counts null when the actor omits them (unknown, never 0)", () => {
    const t = normalizeTweet(SAMPLE);
    expect(t!.likes).toBeNull();
    expect(t!.reposts).toBeNull();
    expect(t!.replies).toBeNull();
    // a real reported 0 is preserved (not coerced to null)
    expect(normalizeTweet({ ...SAMPLE, likeCount: 0 })!.likes).toBe(0);
  });

  it("treats a missing/garbage follower count as null (unknown, never punished)", () => {
    expect(normalizeTweet({ ...SAMPLE, author: { userName: "x", followers: undefined } })!.author.followers).toBeNull();
    expect(normalizeTweet({ ...SAMPLE, author: { userName: "x", followers: "nope" } })!.author.followers).toBeNull();
    // String-numeric counts are coerced.
    expect(normalizeTweet({ ...SAMPLE, author: { userName: "x", followers: "1500" } })!.author.followers).toBe(1500);
  });
});

describe("createApifyXClient.userTweets", () => {
  it("calls the run endpoint with a from: search term + token and returns normalised tweets", async () => {
    const h = harness(() => ({ items: [SAMPLE] }));
    const res = await h.client.userTweets({ handle: "@devbuilder", limit: 25 });
    expect(h.startUrl()).toContain(`/v2/acts/${X_SCRAPER_ACTOR_ID}/runs`);
    expect(h.startUrl()).toContain("token=tok-123");
    // kaito has no twitterHandles input — a single user's timeline is the from: operator.
    expect(h.body().searchTerms).toEqual(["from:devbuilder"]); // @ stripped
    expect(h.body().twitterHandles).toBeUndefined();
    expect(h.body().maxItems).toBe(25);
    expect(res.tweets).toHaveLength(1);
    expect(res.resultCount).toBe(1);
    expect(res.tweets[0]!.author.handle).toBe("devbuilder");
  });

  it("filters out tweets at/before the sinceISO window but still reports raw resultCount", async () => {
    const old = { ...SAMPLE, id: "1", createdAt: "Mon Jan 01 00:00:00 +0000 2020" };
    const fresh = { ...SAMPLE, id: "2", createdAt: "Wed Jun 18 14:03:12 +0000 2025" };
    const h = harness(() => ({ items: [old, fresh] }));
    const res = await h.client.userTweets({ handle: "x", limit: 40, sinceISO: "2024-01-01T00:00:00.000Z" });
    expect(res.tweets.map((t) => t.id)).toEqual(["2"]);
    expect(res.resultCount).toBe(2); // metered on raw count, not the filtered set
  });

  it("dedupes repeated ids", async () => {
    const h = harness(() => ({ items: [SAMPLE, SAMPLE] }));
    const res = await h.client.userTweets({ handle: "x", limit: 40 });

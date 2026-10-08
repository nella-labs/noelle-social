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
    expect(res.tweets).toHaveLength(1);
    expect(res.resultCount).toBe(2);
  });

  it("appends server-side operators (replies/retweets/window) to the from: query", async () => {
    // from: is a search query, so it honours the same advanced-search operators
    // the keyword lane already uses. Excluding server-side matters because the
    // actor bills per RETURNED item: a reply or out-of-window tweet fetched here
    // is paid for and then dropped client-side.
    const h = harness(() => ({ items: [] }));
    const sinceISO = "2026-06-10T06:00:00.000Z";
    await h.client.userTweets({
      handle: "@DevBuilder",
      limit: 20,
      sinceISO,
      excludeReplies: true,
      excludeRetweets: true,
    });
    expect(h.body().searchTerms).toEqual([
      `from:DevBuilder -filter:replies -filter:nativeretweets since_time:${Math.floor(new Date(sinceISO).getTime() / 1000)}`,
    ]);
    expect(h.body().maxItems).toBe(20);
  });

  it("keeps the bare from: query when no operator flags are set", async () => {
    const h = harness(() => ({ items: [] }));
    await h.client.userTweets({ handle: "devbuilder", limit: 20 });
    expect(h.body().searchTerms).toEqual(["from:devbuilder"]);
  });
});

describe("createApifyXClient.searchTimeline", () => {
  it("passes the query through as searchTerms", async () => {
    const h = harness(() => ({ items: [SAMPLE] }));
    const res = await h.client.searchTimeline({ query: "ai agents min_faves:10", limit: 30 });
    expect(h.body().searchTerms).toEqual(["ai agents min_faves:10"]);
    expect(h.body().maxItems).toBe(30);
    expect(res.tweets).toHaveLength(1);
  });
});

describe("error handling", () => {
  it("throws ApifyXError with the status on a non-ok response", async () => {
    const h = harness(() => ({ status: 402, text: "nope" }));
    await expect(h.client.userTweets({ handle: "x" })).rejects.toMatchObject({
      name: "ApifyXError",
      status: 402,
    });
  });

  it("wraps a network failure as ApifyXError status 0", async () => {
    const client = createApifyXClient({
      token: "t",
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    await expect(client.userTweets({ handle: "x" })).rejects.toBeInstanceOf(ApifyXError);
  });
});

describe("checkApifyToken", () => {
  it("returns alive + usage + the real cycle reset on a 200", async () => {
    let calledUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calledUrl = input.toString();
      return new Response(
        JSON.stringify({
          data: {
            plan: "FREE",
            current: { monthlyUsageUsd: 3.5 },
            limits: { maxMonthlyUsageUsd: 5 },
            monthlyUsageCycle: { startAt: "2026-06-20T00:00:00.000Z", endAt: "2026-07-19T23:59:59.999Z" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const h = await checkApifyToken("apify_api_good", { fetchImpl });
    expect(h.alive).toBe(true);
    expect(h.httpStatus).toBe(200);
    expect(h.remainingUsd).toBe(1.5);
    expect(h.cycleEndAt).toBe("2026-07-19T23:59:59.999Z");
    expect(calledUrl).toContain("/v2/users/me/limits");
    expect(calledUrl).toContain("token=apify_api_good");
  });

  it("omits cycleEndAt when the cycle isn't reported", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { current: { monthlyUsageUsd: 1 } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const h = await checkApifyToken("t", { fetchImpl });
    expect(h.alive).toBe(true);
    expect(h.cycleEndAt).toBeUndefined();
  });

  it("returns not-alive with httpStatus 401 on a genuinely bad/banned token", async () => {
    const fetchImpl = (async () =>
      new Response("token-not-found", { status: 401 })) as unknown as typeof fetch;
    const h = await checkApifyToken("apify_api_dead", { fetchImpl });
    expect(h.alive).toBe(false);
    expect(h.httpStatus).toBe(401);
  });

  it("returns not-alive httpStatus 0 on a network error (never throws)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const h = await checkApifyToken("t", { fetchImpl });
    expect(h.alive).toBe(false);
    expect(h.httpStatus).toBe(0);
    expect(h.error).toContain("request failed");
  });
});

describe("runActorSync real cost capture (drainLastRunUsd)", () => {
  it("captures the run's real usageTotalUsd and drains it (reset to null on re-read)", async () => {
    const h = harness(() => ({ items: [SAMPLE], usageTotalUsd: 0.37 }));
    await h.client.userTweets({ handle: "devbuilder", limit: 25 });
    expect(h.client.drainLastRunUsd?.()).toBe(0.37);
    // Drained: a second read (no new run) is null → caller falls back to estimate.
    expect(h.client.drainLastRunUsd?.()).toBeNull();
  });

  it("is null when the run object reports no usage", async () => {
    const h = harness(() => ({ items: [SAMPLE] })); // no usageTotalUsd
    await h.client.userTweets({ handle: "devbuilder" });
    expect(h.client.drainLastRunUsd?.()).toBeNull();
  });

  it("polls a still-running run to completion, then returns its items + cost", async () => {
    const h = harness(() => ({ items: [SAMPLE], usageTotalUsd: 0.02, runStatus: "RUNNING" }));
    const res = await h.client.userTweets({ handle: "devbuilder" });
    expect(res.tweets).toHaveLength(1);
    expect(h.client.drainLastRunUsd?.()).toBe(0.02);
  });

  it("throws (and records no cost) when the run finishes not-SUCCEEDED", async () => {
    const h = harness(() => ({ items: [SAMPLE], runStatus: "FAILED" }));
    await expect(h.client.userTweets({ handle: "devbuilder" })).rejects.toBeInstanceOf(ApifyXError);
    expect(h.client.drainLastRunUsd?.()).toBeNull();
  });

  it("surfaces a token-fatal status on the run start so the rotator can retire it", async () => {
    const h = harness(() => ({ status: 403, text: "Monthly usage hard limit exceeded" }));
    await expect(h.client.userTweets({ handle: "devbuilder" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("scrapeFollowers (person discovery)", () => {
  const person = (over: Record<string, unknown> = {}) => ({
    userName: "cand",
    id: "9",
    name: "A Candidate",
    description: "founder, devtools",
    followers: 1200,
    ...over,
  });

  // Minimal fake of the run lifecycle: POST /runs -> GET run -> GET dataset.
  function fakeApify(items: unknown[]) {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ data: { id: "r1", status: "SUCCEEDED", defaultDatasetId: "d1", usageTotalUsd: 0.03 } }),
          { status: 201 },
        );
      }
      if (url.includes("/datasets/")) return new Response(JSON.stringify(items), { status: 200 });
      return new Response(
        JSON.stringify({ data: { id: "r1", status: "SUCCEEDED", defaultDatasetId: "d1", usageTotalUsd: 0.03 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("targets the FOLLOWER actor, not the tweet actor", async () => {
    const { fetchImpl, calls } = fakeApify([person()]);
    const c = createApifyXClient({ token: "t", fetchImpl });
    await c.scrapeFollowers({ seedHandles: ["seed"], maxUsers: 5 });
    const post = calls.find((x) => x.body);
    expect(post!.url).toContain("kaitoeasyapi~premium-x-follower-scraper-following-data");
  });

  it("normalises a person, keeping the BIO the ICP gate needs", async () => {
    const { fetchImpl } = fakeApify([person()]);
    const c = createApifyXClient({ token: "t", fetchImpl });
    const { people } = await c.scrapeFollowers({ seedHandles: ["seed"], maxUsers: 5 });
    expect(people[0]).toEqual({
      handle: "cand",
      id: "9",
      displayName: "A Candidate",
      bio: "founder, devtools",
      followers: 1200,
    });
  });

  it("tolerates the actor's key-casing variants", async () => {
    const { fetchImpl } = fakeApify([
      { screen_name: "@Other", id_str: "7", displayname: "Other", rawDescription: "building things", followers_count: 30 },
    ]);
    const c = createApifyXClient({ token: "t", fetchImpl });
    const { people } = await c.scrapeFollowers({ seedHandles: ["seed"], maxUsers: 5 });
    expect(people[0]).toMatchObject({ handle: "other", id: "7", bio: "building things", followers: 30 });
  });

  it("keeps an absent bio as NULL, never an empty string", async () => {
    // null means UNKNOWN to the ICP gate; "" would read as a real empty bio.
    const { fetchImpl } = fakeApify([person({ description: "   " })]);
    const c = createApifyXClient({ token: "t", fetchImpl });
    const { people } = await c.scrapeFollowers({ seedHandles: ["seed"], maxUsers: 5 });
    expect(people[0]!.bio).toBeNull();
  });

  it("drops the seed accounts themselves and de-dupes across seed lists", async () => {
    const { fetchImpl } = fakeApify([person({ userName: "seed" }), person(), person()]);
    const c = createApifyXClient({ token: "t", fetchImpl });
    const { people } = await c.scrapeFollowers({ seedHandles: ["seed"], maxUsers: 10 });
    expect(people.map((p) => p.handle)).toEqual(["cand"]);
  });

  it("caps the returned people at maxUsers", async () => {
    const many = Array.from({ length: 50 }, (_, i) => person({ userName: `u${i}`, id: String(i) }));
    const { fetchImpl } = fakeApify(many);
    const c = createApifyXClient({ token: "t", fetchImpl });
    const { people } = await c.scrapeFollowers({ seedHandles: ["seed"], maxUsers: 7 });
    expect(people).toHaveLength(7);
  });

  it("spends NOTHING when there are no seeds or the cap is zero", async () => {
    const { fetchImpl, calls } = fakeApify([person()]);
    const c = createApifyXClient({ token: "t", fetchImpl });
    expect(await c.scrapeFollowers({ seedHandles: [], maxUsers: 5 })).toEqual({ people: [], resultCount: 0 });
    expect(await c.scrapeFollowers({ seedHandles: ["seed"], maxUsers: 0 })).toEqual({ people: [], resultCount: 0 });
    expect(calls).toHaveLength(0); // no actor run was started at all
  });

  it("floors the actor's list size at its 200 minimum", async () => {
    const { fetchImpl, calls } = fakeApify([person()]);
    const c = createApifyXClient({ token: "t", fetchImpl });
    await c.scrapeFollowers({ seedHandles: ["seed"], maxUsers: 5 });
    const body = calls.find((x) => x.body)!.body as { maxFollowers: number };
    expect(body.maxFollowers).toBe(200);
  });
});

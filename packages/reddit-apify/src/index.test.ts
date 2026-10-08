import { describe, expect, it } from "vitest";
import {
  createApifyRedditClient,
  normalizeRedditPost,
  normalizeRedditComment,
  fetchRedditPostComments,
  ApifyError,
  SUBREDDIT_POSTS_ACTOR_ID,
} from "./index.js";

// A self (text) post from the parseforge/reddit-posts-scraper actor. id carries
// the "t3_" fullname prefix; permalink is a relative path; createdAt is unix
// seconds; url mirrors the permalink (self post → no external link).
const SAMPLE = {
  id: "t3_1abc23",
  title: "I shipped my SaaS in a weekend and here's what broke",
  selfText: "long story short: auth. always auth.",
  author: "indie_hacker_42",
  subreddit: "SaaS",
  permalink: "/r/SaaS/comments/1abc23/i_shipped_my_saas_in_a_weekend/",
  url: "https://www.reddit.com/r/SaaS/comments/1abc23/i_shipped_my_saas_in_a_weekend/",
  createdAt: 1748390400, // 2025-05-28T00:00:00Z (unix seconds)
  score: 342,
  upvoteRatio: 0.97,
  numComments: 58,
  over18: false,
};

// A link post: url points at an external target distinct from the permalink, and
// there is no body text.
const LINK_SAMPLE = {
  id: "t3_2def45",
  title: "Great write-up on cold email",
  author: { name: "growth_nerd" },
  subreddit: "r/Entrepreneur",
  permalink: "/r/Entrepreneur/comments/2def45/great_writeup/",
  url: "https://example.com/cold-email",
  created_utc: 1748390400,
  numComments: 3,
};

// A post WITH image media (preview + gallery) and nested comments of mixed score.
// previewImages carries a bare string; galleryData carries {url} objects; the
// comments array is deliberately out of score order to exercise the sort.
const MEDIA_SAMPLE = {
  id: "t3_img99",
  title: "Our MRR chart after 3 months",
  selfText: "",
  author: "founder_x",
  subreddit: "SaaS",
  permalink: "/r/SaaS/comments/img99/mrr_chart/",
  createdAt: 1748390400,
  score: 500,
  numComments: 3,
  previewImages: ["https://preview.redd.it/abc.png"],
  galleryData: [{ url: "https://i.redd.it/g1.jpg" }, { url: "https://i.redd.it/g2.jpg" }],
  comments: [
    { id: "t1_c1", body: "low-score take", score: 5, author: "a", permalink: "/r/SaaS/comments/img99/mrr_chart/c1/" },
    { id: "t1_c2", body: "the top take", score: 120, author: { username: "b" }, permalink: "/r/SaaS/comments/img99/mrr_chart/c2/" },
    { id: "t1_c3", body: "middle", score: 40, author: "c", permalink: "/r/SaaS/comments/img99/mrr_chart/c3/" },
    { body: "", score: 999, author: "empty" }, // no body → dropped, never throws
  ],
};

/**
 * Simulates Apify's async run flow the client now uses: POST /v2/acts/{id}/runs
 * (returns the run object, where token-fatal errors surface), an optional poll of
 * GET /v2/actor-runs/{id} while the run is non-terminal, then GET
 * /v2/datasets/{id}/items for the results. The handler keeps the old contract
 * ({ status, items, text }) plus `usageTotalUsd` (the real per-run cost the run
 * reports) and `runStatus` (terminal state to simulate a failed/aborted run, or
 * "RUNNING" to force one poll before it succeeds).
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
  const client = createApifyRedditClient({ token: "apify_api_test", fetchImpl, timeoutMs: 4000 });
  return { client, url: () => lastUrl, startUrl: () => startUrl, body: () => lastBody };
}

describe("normalizeRedditPost", () => {
  it.each([undefined, null, "", " ", NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("keeps malformed score/count %j unknown", (value) => {
    const post = normalizeRedditPost({ ...SAMPLE, score: value, numComments: value })!;
    expect(post.score).toBeNull();
    expect(post.numComments).toBeNull();
    expect(normalizeRedditComment({ body: "a concrete source comment", score: value })!.score).toBeNull();
  });

  it("preserves measured signed scores and zero, and skips malformed candidates", () => {
    expect(normalizeRedditPost({ ...SAMPLE, score: -3, numComments: 0 })).toMatchObject({ score: -3, numComments: 0 });
    expect(normalizeRedditPost({ ...SAMPLE, score: "", ups: "-4", numComments: "", num_comments: "0" }))
      .toMatchObject({ score: -4, numComments: 0 });
    expect(normalizeRedditPost({ ...SAMPLE, score: 0, numComments: -1 })).toMatchObject({ score: 0, numComments: null });
    expect(normalizeRedditComment({ body: "a source comment", score: "", upVotes: "-2" })!.score).toBe(-2);
  });

  it("ranks measured zero and negative comments before stable unknown measurements", () => {
    const post = normalizeRedditPost({ ...SAMPLE, comments: [
      { body: "first unknown", score: undefined }, { body: "real negative", score: -2 },
      { body: "second unknown", score: "" }, { body: "real zero", score: 0 },
    ] })!;
    expect(post.topComments?.map(c => c.body)).toEqual(["real zero", "real negative", "first unknown", "second unknown"]);
  });

  it.each(["2026-02-30T12:00:00Z", "2026-02-29T12:00:00Z", Number.MAX_SAFE_INTEGER, 253_402_300_800, 1.5])("keeps invalid calendar/epoch %j unknown without throwing", (createdAt) => {
    expect(normalizeRedditPost({ ...SAMPLE, createdAt })!.createdAt).toBe("");
  });

  it("retains valid string dates and native seconds including epoch zero", () => {
    expect(normalizeRedditPost({ ...SAMPLE, createdAt: 0 })!.createdAt).toBe("1970-01-01T00:00:00.000Z");
    expect(normalizeRedditPost({ ...SAMPLE, createdAt: "2024-02-29T12:00:00+02:00" })!.createdAt).toBe("2024-02-29T10:00:00.000Z");
  });

  it.each(["", "2026-02-30T12:00:00Z", Number.MAX_SAFE_INTEGER])("does not let invalid preferred source date %j shadow a measured fallback", createdAt => {
    expect(normalizeRedditPost({ ...SAMPLE, createdAt, created_utc: SAMPLE.createdAt })!.createdAt).toBe("2025-05-28T00:00:00.000Z");
  });

  it.each(["", " "])("keeps blank upvote ratio %j unknown while preserving measured fractional ratios", upvoteRatio => {
    expect(normalizeRedditPost({ ...SAMPLE, upvoteRatio })!.upvoteRatio).toBeUndefined();
    expect(normalizeRedditPost({ ...SAMPLE, upvoteRatio: 0 })!.upvoteRatio).toBe(0);
    expect(normalizeRedditPost({ ...SAMPLE, upvoteRatio: 0.97 })!.upvoteRatio).toBe(0.97);
  });

  it("maps the Apify reddit shape to our RedditPost (strips t3_, builds URL)", () => {
    const p = normalizeRedditPost(SAMPLE)!;
    expect(p.id).toBe("1abc23"); // t3_ stripped
    expect(p.title).toContain("shipped my SaaS");
    expect(p.body).toBe("long story short: auth. always auth.");
    expect(p.url).toBe(
      "https://www.reddit.com/r/SaaS/comments/1abc23/i_shipped_my_saas_in_a_weekend/",
    );
    expect(p.subreddit).toBe("SaaS");
    expect(p.score).toBe(342);
    expect(p.upvoteRatio).toBe(0.97);
    expect(p.numComments).toBe(58);
    expect(p.author).toEqual({ username: "indie_hacker_42" });
    expect(p.createdAt).toBe(new Date(1748390400 * 1000).toISOString());
    // self post: url == permalink, so externalUrl is omitted
    expect("externalUrl" in p).toBe(false);
  });

  it("builds the canonical URL from a relative permalink path", () => {
    const p = normalizeRedditPost({ ...SAMPLE, permalink: "/r/SaaS/comments/x/y/", url: undefined })!;
    expect(p.url).toBe("https://www.reddit.com/r/SaaS/comments/x/y/");
  });

  it("surfaces externalUrl + strips the r/ prefix on a link post", () => {
    const p = normalizeRedditPost(LINK_SAMPLE)!;
    expect(p.id).toBe("2def45");
    expect(p.body).toBe("");
    expect(p.url).toBe("https://www.reddit.com/r/Entrepreneur/comments/2def45/great_writeup/");
    expect(p.externalUrl).toBe("https://example.com/cold-email");
    expect(p.subreddit).toBe("Entrepreneur"); // "r/" stripped
    expect(p.author).toEqual({ username: "growth_nerd" });
  });

  it("returns null when there's no id or no title", () => {
    expect(normalizeRedditPost({ id: "t3_1", title: "" })).toBeNull();
    expect(normalizeRedditPost({ title: "no id here" })).toBeNull();
    expect(normalizeRedditPost(null)).toBeNull();
    expect(normalizeRedditPost("nope")).toBeNull();
  });

  it("coalesces images (preview + gallery) and top comments sorted by score desc, sliced", () => {
    const p = normalizeRedditPost(MEDIA_SAMPLE, { commentsPerPost: 2 })!;
    // Images: preview string first, then each gallery {url}, deduped + http-only.
    expect(p.images).toEqual([
      "https://preview.redd.it/abc.png",
      "https://i.redd.it/g1.jpg",
      "https://i.redd.it/g2.jpg",
    ]);
    // Top comments: empty-body dropped, sorted desc, sliced to commentsPerPost=2,
    // t1_ stripped, object author resolved, permalink made canonical.
    expect(p.topComments).toHaveLength(2);
    expect(p.topComments!.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(p.topComments![0]).toMatchObject({ id: "c2", score: 120, author: "b" });
    expect(p.topComments![0]!.permalink).toBe(
      "https://www.reddit.com/r/SaaS/comments/img99/mrr_chart/c2/",
    );
  });

  it("defaults to 8 top comments and omits images/topComments when the post has neither", () => {
    // MEDIA_SAMPLE has 3 non-empty comments; default cap (8) keeps all 3.
    expect(normalizeRedditPost(MEDIA_SAMPLE)!.topComments).toHaveLength(3);
    // A plain self post → no media, no comments → both keys omitted (never []).
    const plain = normalizeRedditPost(SAMPLE)!;
    expect("images" in plain).toBe(false);
    expect("topComments" in plain).toBe(false);
  });

  it("salvages an image URL from the post url when it points at an image", () => {
    const p = normalizeRedditPost({ ...SAMPLE, url: "https://i.redd.it/xyz.jpg", permalink: "/r/SaaS/c/x/y/" })!;
    expect(p.images).toEqual(["https://i.redd.it/xyz.jpg"]);
  });
});

describe("subredditPosts", () => {
  it("omitting commentsPerPost fetches posts only — comments are opt-in (cost guard)", async () => {
    const h = harness(() => ({ items: [SAMPLE] }));
    const posts = await h.client.subredditPosts({ subreddit: "SaaS" });
    expect(h.startUrl()).toContain(`/v2/acts/${SUBREDDIT_POSTS_ACTOR_ID}/runs`);
    expect(h.startUrl()).toContain("token=apify_api_test");
    expect(h.body().mode).toBe("subreddit");
    expect(h.body().subreddit).toBe("SaaS");
    expect(h.body().sort).toBe("new"); // default
    expect(h.body().timeRange).toBe("day"); // default
    expect(h.body().maxItems).toBe(50); // default
    expect(h.body().postType).toBe("all");
    // No commentsPerPost passed ⇒ comments OFF, so a consumer that ignores comments
    // never pays the ~5× comment-scrape cost.
    expect(h.body().includeComments).toBe(false);
    expect(h.body().commentsPerPost).toBe(0);
    expect(h.body().commentSort).toBe("top");
    expect(h.body().includeNsfw).toBe(false);
    expect((h.body().proxyConfiguration as { apifyProxyGroups?: string[] }).apifyProxyGroups).toEqual([
      "RESIDENTIAL",
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.id).toBe("1abc23");
    expect(posts[0]!.author.username).toBe("indie_hacker_42");
  });

  it("passes commentsPerPost through to the actor input", async () => {
    const h = harness(() => ({ items: [SAMPLE] }));
    await h.client.subredditPosts({ subreddit: "SaaS", commentsPerPost: 15 });
    expect(h.body().commentsPerPost).toBe(15);
    expect(h.body().includeComments).toBe(true); // opt-in flips on when comments are requested
  });

  it("groups standalone comment items (dataType/type='comment') under their parent post", async () => {
    // Post item carries no nested comments; two standalone comment rows reference
    // it by link_id (t3_) and by bare postId respectively, out of score order.
    const postItem = { ...SAMPLE };
    const c1 = {
      dataType: "comment",
      id: "t1_x1",
      body: "standalone lower",
      score: 9,
      author: "z",
      link_id: "t3_1abc23",
      permalink: "/r/SaaS/comments/1abc23/x/x1/",
    };
    const c2 = { type: "comment", id: "t1_x2", body: "standalone higher", score: 88, author: "y", postId: "1abc23" };
    const h = harness(() => ({ items: [postItem, c1, c2] }));
    const posts = await h.client.subredditPosts({ subreddit: "SaaS", commentsPerPost: 5 });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.topComments!.map((c) => c.id)).toEqual(["x2", "x1"]); // score desc
    expect(posts[0]!.topComments![0]!.author).toBe("y");
  });

  it("filters out posts older than sinceISO", async () => {
    const h = harness(() => ({ items: [SAMPLE] })); // SAMPLE is 2025-05-28
    const dropped = await h.client.subredditPosts({ subreddit: "SaaS", sinceISO: "2025-06-01T00:00:00Z" });
    expect(dropped).toHaveLength(0);
    const kept = await h.client.subredditPosts({ subreddit: "SaaS", sinceISO: "2025-05-01T00:00:00Z" });
    expect(kept).toHaveLength(1);
  });

  it("propagates a 402 as an ApifyError with status===402 (quota surfaces)", async () => {
    const h = harness(() => ({ status: 402, text: "Monthly usage hard limit exceeded" }));
    await expect(h.client.subredditPosts({ subreddit: "SaaS" })).rejects.toBeInstanceOf(ApifyError);
    await expect(h.client.subredditPosts({ subreddit: "SaaS" })).rejects.toMatchObject({ status: 402 });
  });

  it("requires a subreddit", async () => {
    const h = harness(() => ({ items: [] }));
    await expect(h.client.subredditPosts({ subreddit: "" })).rejects.toBeInstanceOf(ApifyError);
  });
});

// --- fetchRedditPostComments (the free public .json read) ---------------------
// This source spends NO Apify budget and supplies no id/permalink — it's the
// "read the room" sibling-comment fetch, not a comment-targeting source.

describe("fetchRedditPostComments", () => {
  // Reddit's comments endpoint returns a two-element array: [postListing,
  // commentListing]; the comments live under [1].data.children as {kind,data} nodes.
  function listing(children: Array<{ kind: string; data: Record<string, unknown> }>) {
    return [
      { kind: "Listing", data: { children: [] } }, // post listing (ignored)
      { kind: "Listing", data: { children } }, // comment listing
    ];
  }

  // A fetch that records requested URLs and replies with `payload` (JSON) at `status`.
  function recordingFetch(payload: unknown, status = 200) {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(input.toString());
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("parses the two-element listing, drops deleted/removed/stickied/AutoModerator, sorts by score desc", async () => {
    const { fetchImpl, calls } = recordingFetch(
      listing([
        { kind: "t1", data: { author: "alice", body: "a middling take", score: 40 } },
        { kind: "t1", data: { author: "bob", body: "the top take", score: 120 } },
        { kind: "t1", data: { author: "carol", body: "[deleted]", score: 999 } }, // deleted body → drop
        { kind: "t1", data: { author: "dave", body: "[removed]", score: 999 } }, // removed body → drop
        { kind: "t1", data: { author: "mods", body: "the rules", score: 999, stickied: true } }, // pinned → drop
        { kind: "t1", data: { author: "AutoModerator", body: "beep boop", score: 999 } }, // automod → drop
        { kind: "t1", data: { author: "[deleted]", body: "ghost", score: 999 } }, // deleted author → drop
        { kind: "more", data: { count: 12 } }, // "more" node, not a comment → drop
        { kind: "t1", data: { author: "erin", body: "a quiet take", score: 5 } },
      ]),
    );
    const comments = await fetchRedditPostComments({ postId: "t3_abc123", sort: "top", fetchImpl });

    // Only the three real comments survive, ranked by score desc, authors "u/"-prefixed.
    expect(comments).toEqual([
      { author: "u/bob", body: "the top take", score: 120 },
      { author: "u/alice", body: "a middling take", score: 40 },
      { author: "u/erin", body: "a quiet take", score: 5 },
    ]);
    // The free .json source supplies no id/permalink (so these can't be actuated).
    expect(comments[0]).not.toHaveProperty("id");
    expect(comments[0]).not.toHaveProperty("permalink");
    // Hits the free public endpoint with the t3_ prefix stripped.
    expect(calls[0]).toContain("/comments/abc123.json");
    expect(calls[0]).toContain("sort=top");
    expect(calls[0]).toContain("depth=1");
  });

  it("caps the result at `limit`, keeping the highest-scored", async () => {
    const { fetchImpl } = recordingFetch(
      listing(
        Array.from({ length: 20 }, (_, i) => ({
          kind: "t1",
          data: { author: `u${i}`, body: `c${i}`, score: i },
        })),
      ),
    );
    const comments = await fetchRedditPostComments({ postId: "abc123", limit: 3, fetchImpl });
    expect(comments).toHaveLength(3);
    expect(comments.map((c) => c.score)).toEqual([19, 18, 17]);
  });

  it("fails open (returns []) on non-200, a bad shape, or a blank postId", async () => {
    // 429 / 403 / 404 → [] (fail open, drafting proceeds with no room context)
    expect(
      await fetchRedditPostComments({ postId: "abc", fetchImpl: recordingFetch({}, 429).fetchImpl }),
    ).toEqual([]);
    // Single-element body (not the [post, comments] pair) → []
    expect(
      await fetchRedditPostComments({ postId: "abc", fetchImpl: recordingFetch([{ data: {} }]).fetchImpl }),
    ).toEqual([]);
    // Blank postId → [] with no fetch at all.
    const spy = recordingFetch(listing([]));
    expect(await fetchRedditPostComments({ postId: "   ", fetchImpl: spy.fetchImpl })).toEqual([]);
    expect(spy.calls).toHaveLength(0);
  });
});

describe("runActorSync real cost capture (drainLastRunUsd)", () => {
  it("captures the run's real usageTotalUsd and drains it (reset to null on re-read)", async () => {
    const h = harness(() => ({ items: [SAMPLE], usageTotalUsd: 0.37 }));
    await h.client.subredditPosts({ subreddit: "SaaS" });
    expect(h.client.drainLastRunUsd?.()).toBe(0.37);

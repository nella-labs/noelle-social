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


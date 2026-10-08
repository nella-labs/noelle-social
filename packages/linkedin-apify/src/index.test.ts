import { describe, expect, it } from "vitest";
import {
  createApifyLinkedInClient,
  checkApifyToken,
  normalizePost,
  normalizeComment,
  normalizeAuthoredComment,
  normalizeProfile,
  isMemberUrnId,
  slugFromPostUrl,
  resolveVanitySlug,
  ApifyError,
  AUTHORED_COMMENTS_SUPPORTED,
  PROFILE_POSTS_ACTOR_ID,
  POST_SEARCH_ACTOR_ID,
  POST_COMMENTS_ACTOR_ID,
  PROFILE_COMMENTS_ACTOR_ID,
} from "./index.js";

const SAMPLE_COMMENT = {
  id: "urn:li:comment:(activity:7300000000000000000,7300000000000000001)",
  linkedinUrl: "https://www.linkedin.com/feed/update/.../?commentUrn=...",
  commentary: "this is the part everyone misses, commenting IS the distribution",
  createdAt: 1780000000000,
  numComments: 2,
  reactionTypeCounts: [
    { type: "LIKE", count: 8 },
    { type: "EMPATHY", count: 2 },
  ],
  actor: {
    name: "Dev Patel",
    position: "Founder, building in public",
    linkedinUrl: "https://www.linkedin.com/in/dev-patel",
  },
};

// The profile-comments actor (harvestapi/linkedin-profile-comments) output shape:
// counts are nested under `engagement` (likes/comments/reactions[]) — NOT the
// flat numComments/reactionTypeCounts of the post-comments actor. `actor` is the
// target profile (whoever authored the comment); `post` is the parent post.
const SAMPLE_AUTHORED_COMMENT = {
  id: "urn:li:comment:(activity:7411111111111111111,7411111111111111112)",
  linkedinUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7411111111111111111?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7411111111111111111%2C7411111111111111112%29",
  commentary: "totally — the moat is distribution, not the model. ship in public and let the replies compound.",
  createdAt: "2026-06-15T09:30:00.000Z",
  createdAtTimestamp: 1781940600000,
  engagement: {
    likes: 12,
    comments: 3,
    reactions: [
      { type: "LIKE", count: 9 },
      { type: "PRAISE", count: 3 },
    ],
  },
  actor: {
    name: "Satya Nadella",
    position: "Chairman and CEO at Microsoft",
    linkedinUrl: "https://www.linkedin.com/in/satyanadella",
  },
  post: {
    content: "Why distribution beats the model",
    author: { name: "Some Builder", publicIdentifier: "some-builder" },
  },
};

const SAMPLE = {
  id: "urn:li:activity:7300000000000000000",
  linkedinUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000000/",
  content: "building the seen — here's what I learned this week",
  author: {
    name: "Kaia Tham",
    publicIdentifier: "kaia-tham",
    linkedinUrl: "https://www.linkedin.com/in/kaia-tham",
    info: "17 building the seen",
  },
  postedAt: { timestamp: 1780000000000, date: "2026-05-28", postedAgoText: "2w" },
  engagement: { likes: 120, comments: 14, shares: 3 },
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
  const client = createApifyLinkedInClient({ token: "apify_api_test", fetchImpl, timeoutMs: 4000 });
  return { client, url: () => lastUrl, startUrl: () => startUrl, body: () => lastBody };
}

describe("normalizePost", () => {
  it("maps the Apify post shape to our LinkedInPost", () => {
    const p = normalizePost(SAMPLE)!;
    expect(p.id).toBe("7300000000000000000");
    expect(p.urn).toBe("urn:li:activity:7300000000000000000");
    expect(p.text).toContain("building the seen");
    expect(p.url).toContain("/feed/update/");
    expect(p.reactions).toBe(120);
    expect(p.comments).toBe(14);
    expect(p.postedAt).toBe(new Date(1780000000000).toISOString());
    expect(p.author).toEqual({
      name: "Kaia Tham",
      publicId: "kaia-tham",
      url: "https://www.linkedin.com/in/kaia-tham",
      headline: "17 building the seen",
      type: null,
    });
  });

  it("drops items with no text or no id", () => {
    expect(normalizePost({ id: "urn:li:activity:1", content: "" })).toBeNull();
    expect(normalizePost({ content: "hi" })).toBeNull();
  });

  // Regression: the actor returned the opaque member urn as publicIdentifier for
  // ~6 people Lyra had replied to 6-17 times. publicId is the profiler's only key
  // (profilePosts({publicId})), so each one backed off with "no public_id" and was
  // never profiled — while their own permalink spelled the slug out.
  it("recovers the vanity slug from the post permalink when publicIdentifier is a member urn", () => {
    const p = normalizePost({
      id: "urn:li:activity:7473904945554038784",
      content: "as long as you're thinking about your hurts",
      linkedinUrl:
        "https://www.linkedin.com/posts/pallifrone_as-long-as-youre-thinking-activity-7473904945554038784-o29i",
      author: {
        name: "Phil P.",
        publicIdentifier: "ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s",
        linkedinUrl: "https://www.linkedin.com/in/ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s",
      },
    })!;
    expect(p.author.publicId).toBe("pallifrone");
  });

  it("keeps a real publicIdentifier even when a permalink slug is available", () => {
    const p = normalizePost({
      id: "urn:li:activity:7300000000000000000",
      content: "hello",
      linkedinUrl: "https://www.linkedin.com/posts/some-reposter_hello-activity-7300000000000000000-aaaa",
      author: { publicIdentifier: "kaia-tham" },
    })!;
    expect(p.author.publicId).toBe("kaia-tham");
  });

  it("falls back to the urn when no permalink slug exists (better than null)", () => {
    const p = normalizePost({
      id: "urn:li:activity:7300000000000000001",
      content: "hello",
      linkedinUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000001",
      author: { publicIdentifier: "ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s" },
    })!;
    expect(p.author.publicId).toBe("ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s");
  });
});

describe("resolveVanitySlug", () => {
  it("recognises member urns and leaves real slugs alone", () => {
    expect(isMemberUrnId("ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s")).toBe(true);
    expect(isMemberUrnId("ACoAAFX4vD8BaZrzmCr01DbMFhT1VdnWcYePU94")).toBe(true);
    expect(isMemberUrnId("kaia-tham")).toBe(false);
    // Short "AC…" slugs are real people, not urns.
    expect(isMemberUrnId("acme-ceo")).toBe(false);
    expect(isMemberUrnId(null)).toBe(false);
  });

  it("matches lowercased urns — they reach us that way and were stuck unprofiled", () => {
    // Two such rows sit in linkedin_watchlist_people today, both summary NULL /
    // posts_analyzed 0. A case-SENSITIVE test would skip exactly the people this
    // slug recovery exists to rescue.
    expect(isMemberUrnId("acwaaaeiwl4bfhzj2swxsrw0ynoyjx3nnuthy_e")).toBe(true);
    expect(isMemberUrnId("acwaad1tkembm48rdw7namxkismc-ymj2imm2ei")).toBe(true);
  });

  it("does not misread a real long vanity slug that happens to start with 'ac'", () => {
    // Live data: a genuine 21-char slug. A {20,} rule would call this a urn.
    expect(isMemberUrnId("achim-bonsch-a9186a38")).toBe(false);
    expect(isMemberUrnId("accessibility-lead-x")).toBe(false);
  });

  it("mines the slug out of a post permalink and stops at the first underscore", () => {
    expect(
      slugFromPostUrl("https://www.linkedin.com/posts/rasel-ahmed-628b7239_some-post-activity-123-x"),
    ).toBe("rasel-ahmed-628b7239");
    expect(slugFromPostUrl("https://www.linkedin.com/feed/update/urn:li:activity:123")).toBeNull();
    expect(slugFromPostUrl(null)).toBeNull();
  });

  it("prefers publicId, then the profile url, then the permalink", () => {
    expect(resolveVanitySlug({ publicId: "kaia-tham", postUrl: "https://x/posts/other_a-activity-1" }))
      .toBe("kaia-tham");
    expect(
      resolveVanitySlug({
        publicId: "ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s",
        profileUrl: "https://www.linkedin.com/in/al-kingsley",
        postUrl: "https://www.linkedin.com/posts/from-post_a-activity-1",
      }),
    ).toBe("al-kingsley");
    expect(
      resolveVanitySlug({
        publicId: "ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s",
        profileUrl: "https://www.linkedin.com/in/ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s",
        postUrl: "https://www.linkedin.com/posts/pallifrone_a-activity-1",
      }),
    ).toBe("pallifrone");
    expect(resolveVanitySlug({ publicId: null, postUrl: null })).toBeNull();
  });

  it("omits images entirely on a text-only post (no media fields)", () => {
    const p = normalizePost(SAMPLE)!;
    expect("images" in p).toBe(false);
  });

  it("extracts postImages url(s), deduped and order-preserving", () => {
    const p = normalizePost({
      ...SAMPLE,
      postImages: [
        { url: "https://media.licdn.com/a.jpg", width: 800, height: 600, expiresAt: 1 },
        { url: "https://media.licdn.com/b.jpg" },
        { url: "https://media.licdn.com/a.jpg" }, // dupe — dropped
      ],
    })!;
    expect(p.images).toEqual(["https://media.licdn.com/a.jpg", "https://media.licdn.com/b.jpg"]);
  });

  it("coalesces media from postVideo, article, and document carousel pages", () => {
    const p = normalizePost({
      ...SAMPLE,
      postVideo: { thumbnailUrl: "https://media.licdn.com/thumb.jpg", videoUrl: "https://x/v.mp4" },
      article: { image: { url: "https://media.licdn.com/article.png" } },
      document: {
        coverPages: [
          { imageUrls: ["https://media.licdn.com/p1.png", "https://media.licdn.com/p2.png"] },
          { imageUrls: ["https://media.licdn.com/p3.png"] },
        ],
      },
    })!;
    expect(p.images).toEqual([
      "https://media.licdn.com/thumb.jpg",
      "https://media.licdn.com/article.png",
      "https://media.licdn.com/p1.png",
      "https://media.licdn.com/p2.png",
      "https://media.licdn.com/p3.png",
    ]);
  });

  it("fails open on malformed media (no throw, no images key)", () => {
    const p = normalizePost({
      ...SAMPLE,
      // every plausible field in a broken shape: non-array, missing url, non-http,
      // non-string entries — none should land or throw.
      postImages: [{}, { url: 42 as unknown as string }, { url: "not-a-url" }] as never,
      postVideo: { thumbnailUrl: undefined },
      article: { image: {} },
      document: { coverPages: [{ imageUrls: "nope" as never }, { imageUrls: [null] as never }] },
    })!;
    expect("images" in p).toBe(false);
  });

  // The post-search actor returns the same shape as profile-posts EXCEPT a
  // company author leaves publicIdentifier null (slug is in universalName) and
  // carries author.type. Confirmed against a live post-search run.
  it("falls back to universalName + surfaces author.type (post-search company shape)", () => {
    const p = normalizePost({
      id: "urn:li:activity:7471033556522381312",
      linkedinUrl: "https://www.linkedin.com/posts/stellarph_activity-7471033556522381312",
      content: "We ran a 5-hour AI build hackathon and shipped 7 prototypes.",
      author: {
        name: "StellarPH",
        publicIdentifier: null as unknown as undefined,
        universalName: "stellarph",
        type: "company",
        linkedinUrl: "https://www.linkedin.com/company/stellarph/posts",
        info: "1,211 followers",
      },
      postedAt: { timestamp: 1781233204966, date: "2026-06-12T03:00:04.966Z" },
      engagement: { likes: 1, comments: 0, shares: 0 },
    })!;
    expect(p.author.publicId).toBe("stellarph");
    expect(p.author.type).toBe("company");
    expect(p.reactions).toBe(1);
  });

  it("prefers publicIdentifier over universalName and still surfaces a member author.type", () => {
    const p = normalizePost({
      id: "urn:li:activity:7411033556522381312",
      linkedinUrl: "https://www.linkedin.com/posts/jane-builder_activity-7411033556522381312",
      content: "shipped a thing today, here's the one lesson",
      author: {
        name: "Jane Builder",
        publicIdentifier: "jane-builder",
        universalName: "jane-builder-company-page", // present but must be ignored
        type: "member",
        linkedinUrl: "https://www.linkedin.com/in/jane-builder",
        info: "Founder",
      },
      postedAt: { timestamp: 1781233204966 },
      engagement: { likes: 7, comments: 1 },
    })!;
    expect(p.author.publicId).toBe("jane-builder"); // publicIdentifier wins
    expect(p.author.type).toBe("member");
  });
});

describe("profilePosts", () => {
  it("calls the profile-posts actor with the profile URL built from publicId", async () => {
    const h = harness(() => ({ items: [SAMPLE] }));
    const posts = await h.client.profilePosts({ publicId: "kaia-tham", maxPosts: 5 });
    expect(h.startUrl()).toContain(`/v2/acts/${PROFILE_POSTS_ACTOR_ID}/runs`);
    expect(h.startUrl()).toContain("token=apify_api_test");
    expect(h.body().targetUrls).toEqual(["https://www.linkedin.com/in/kaia-tham"]);
    expect(h.body().maxPosts).toBe(5);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.id).toBe("7300000000000000000");
    expect(posts[0]!.author.publicId).toBe("kaia-tham");
  });

  it("accepts a full profileUrl directly", async () => {
    const h = harness(() => ({ items: [SAMPLE] }));
    await h.client.profilePosts({ profileUrl: "https://www.linkedin.com/in/someone/", maxPosts: 3 });
    expect(h.body().targetUrls).toEqual(["https://www.linkedin.com/in/someone/"]);
  });

  it("filters out posts older than sinceISO", async () => {
    const h = harness(() => ({ items: [SAMPLE] })); // SAMPLE is 2026-05-28
    const posts = await h.client.profilePosts({ publicId: "kaia-tham", sinceISO: "2026-06-01T00:00:00Z" });
    expect(posts).toHaveLength(0);
  });

  it("throws ApifyError on a non-2xx actor run", async () => {
    const h = harness(() => ({ status: 402, text: "Monthly usage hard limit exceeded" }));
    await expect(h.client.profilePosts({ publicId: "kaia-tham" })).rejects.toBeInstanceOf(ApifyError);
  });

  it("requires profileUrl or publicId", async () => {
    const h = harness(() => ({ items: [] }));
    await expect(h.client.profilePosts({})).rejects.toBeInstanceOf(ApifyError);
  });
});

describe("searchPosts", () => {
  it("calls the post-search actor with queries + author filter", async () => {
    const h = harness(() => ({ items: [SAMPLE] }));
    await h.client.searchPosts({
      queries: ["ai agents"],
      authorsPublicIdentifiers: ["kaia-tham"],
      maxPosts: 10,
      postedLimit: "week",
    });
    expect(h.startUrl()).toContain(`/v2/acts/${POST_SEARCH_ACTOR_ID}/runs`);
    expect(h.body().searchQueries).toEqual(["ai agents"]);
    expect(h.body().authorsPublicIdentifiers).toEqual(["kaia-tham"]);
    expect(h.body().sortBy).toBe("date");
    expect(h.body().postedLimit).toBe("week");
  });

  it("applies the sinceISO client-side recency floor", async () => {
    const h = harness(() => ({ items: [SAMPLE] })); // SAMPLE is 2026-05-28
    const recent = await h.client.searchPosts({ queries: ["x"], sinceISO: "2026-06-01T00:00:00Z" });
    expect(recent).toHaveLength(0);

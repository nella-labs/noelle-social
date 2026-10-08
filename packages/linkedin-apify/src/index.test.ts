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

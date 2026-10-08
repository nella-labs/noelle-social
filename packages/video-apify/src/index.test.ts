import { describe, expect, it } from "vitest";
import {
  createApifyVideoClient,
  normalizeInstagramReel,
  normalizeTiktokVideo,
  ApifyError,
  INSTAGRAM_ACTOR_ID,
  INSTAGRAM_FALLBACK_ACTOR_ID,
  INSTAGRAM_SEARCH_ACTOR_ID,
  INSTAGRAM_HASHTAG_ACTOR_ID,
  TIKTOK_ACTOR_ID,
} from "./index.js";

// An apify/instagram-scraper reel item (subset, read defensively).
const IG_SAMPLE = {
  id: "3001",
  shortCode: "Cabc123",
  caption: "3 hooks that doubled my reach",
  ownerUsername: "ChrisDoesViral",
  ownerFullName: "Chris V",
  videoViewCount: 1_200_000,
  likesCount: 84_000,
  commentsCount: 1_900,
  videoUrl: "https://scontent.cdninstagram.com/clip.mp4",
  displayUrl: "https://scontent.cdninstagram.com/thumb.jpg",
  videoDuration: 28.4,
  musicInfo: { audio_id: "9988", song_name: "trending sound" },
  ownerFollowersCount: 240_000,
  timestamp: "2026-06-01T12:00:00.000Z",
};

// A clockworks/tiktok-scraper item (subset).
const TT_SAMPLE = {
  id: "722334455",
  text: "POV: you finally fixed your hook",
  authorMeta: { name: "growthnerd", fans: 510_000 },
  playCount: 2_400_000,
  diggCount: 190_000,
  commentCount: 4_200,
  shareCount: 8_100,
  collectCount: 33_000,
  webVideoUrl: "https://www.tiktok.com/@growthnerd/video/722334455",
  videoMeta: { duration: 19, coverUrl: "https://p16.tiktokcdn.com/cover.jpg", downloadAddr: "https://v16.tiktokcdn.com/v.mp4" },
  musicMeta: { musicId: "555", musicName: "original sound - growthnerd" },
  createTimeISO: "2026-06-10T08:30:00.000Z",
};

/**
 * Simulates Apify's async run flow the client now uses: POST /v2/acts/{id}/runs
 * (returns the run object, where token-fatal errors surface), an optional poll of
 * GET /v2/actor-runs/{id} while the run is non-terminal, then GET
 * /v2/datasets/{id}/items for the results. The handler keeps the old contract
 * ({ status, items, text }) plus `usageTotalUsd` (the real per-run cost the run
 * reports) and `runStatus` (terminal state to simulate a failed/aborted run, or
 * "RUNNING" to force one poll before it succeeds). The handler is invoked with the
 * *actor* POST url + body for all three calls of a given run, so dispatch on the
 * actor slug keeps working on the poll/dataset legs (which carry run/dataset ids).
 */
function harness(
  handler: (
    url: string,
    body: Record<string, unknown>,
  ) => { status?: number; items?: unknown[]; text?: string; usageTotalUsd?: number; runStatus?: string },
  clientOpts: Record<string, unknown> = {},
) {
  let startUrl = "";
  let lastUrl = "";
  let lastBody: Record<string, unknown> = {};
  let runActorUrl = ""; // POST url of the run currently being polled / drained
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
      runActorUrl = url;
      lastBody = init?.body ? JSON.parse(init.body as string) : {};
      const r = handler(url, lastBody);
      if ((r.status ?? 200) >= 400) return new Response(r.text ?? "error", { status: r.status });
      return runObj(r.runStatus ?? "SUCCEEDED", r.usageTotalUsd);
    }
    if (method === "GET" && url.includes("/actor-runs/")) {
      // Poll: the run is now terminal (SUCCEEDED unless the test forced a failure).
      const r = handler(runActorUrl, lastBody);
      const status = r.runStatus && r.runStatus !== "RUNNING" && r.runStatus !== "READY" ? r.runStatus : "SUCCEEDED";
      return runObj(status, r.usageTotalUsd);
    }
    if (method === "GET" && url.includes("/datasets/")) {
      const r = handler(runActorUrl, lastBody);
      return new Response(JSON.stringify(r.items ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = createApifyVideoClient({ token: "apify_api_test", fetchImpl, timeoutMs: 4000, ...clientOpts });
  return { client, url: () => lastUrl, startUrl: () => startUrl, body: () => lastBody };
}

describe("normalizeInstagramReel", () => {
  it("maps the IG shape, lowercases handle, builds reel URL from shortCode", () => {
    const c = normalizeInstagramReel({ ...IG_SAMPLE, url: undefined })!;
    expect(c.id).toBe("3001");
    expect(c.platform).toBe("instagram");
    expect(c.url).toBe("https://www.instagram.com/reel/Cabc123/");
    expect(c.authorHandle).toBe("chrisdoesviral");
    expect(c.views).toBe(1_200_000);
    expect(c.likes).toBe(84_000);
    expect(c.comments).toBe(1_900);
    expect(c.durationSec).toBe(28.4);
    expect(c.musicId).toBe("9988");
    expect(c.musicName).toBe("trending sound");
    expect(c.videoUrl).toBe("https://scontent.cdninstagram.com/clip.mp4");
    expect(c.authorFollowerCount).toBe(240_000);
    expect(c.postedAt).toBe("2026-06-01T12:00:00.000Z");
  });

  it("returns null without an id/shortCode", () => {
    expect(normalizeInstagramReel({ caption: "no id" })).toBeNull();
    expect(normalizeInstagramReel(null)).toBeNull();
    expect(normalizeInstagramReel("nope")).toBeNull();
  });
});

describe("normalizeTiktokVideo", () => {
  it("maps the TikTok shape (diggCount=likes, collectCount=saves, fans=followers)", () => {
    const c = normalizeTiktokVideo(TT_SAMPLE)!;
    expect(c.id).toBe("722334455");
    expect(c.platform).toBe("tiktok");
    expect(c.url).toBe("https://www.tiktok.com/@growthnerd/video/722334455");
    expect(c.authorHandle).toBe("growthnerd");
    expect(c.views).toBe(2_400_000);
    expect(c.likes).toBe(190_000);
    expect(c.comments).toBe(4_200);
    expect(c.shares).toBe(8_100);
    expect(c.saves).toBe(33_000);
    expect(c.durationSec).toBe(19);
    expect(c.musicId).toBe("555");
    expect(c.videoUrl).toBe("https://v16.tiktokcdn.com/v.mp4");
    expect(c.thumbUrl).toBe("https://p16.tiktokcdn.com/cover.jpg");
    expect(c.authorFollowerCount).toBe(510_000);
    expect(c.postedAt).toBe("2026-06-10T08:30:00.000Z");
  });
});

describe("Video source measurements", () => {
  it.each([normalizeInstagramReel, normalizeTiktokVideo])("keeps absent counters and dates unknown", normalize => {
    const c = normalize({ id: "unknown" })!;
    expect([c.views, c.likes, c.comments, c.shares, c.saves, c.postedAt]).toEqual([null, null, null, null, null, null]);
  });
  it("rejects malformed counters while retaining known zero and fractional duration", () => {
    const c = normalizeInstagramReel({ id: "bad", videoViewCount: -1, likesCount: 1.5, commentsCount: "",
      sharesCount: Number.MAX_SAFE_INTEGER + 1, savesCount: true, ownerFollowersCount: -1, videoDuration: 1.5 })!;
    expect([c.views, c.likes, c.comments, c.shares, c.saves, c.authorFollowerCount]).toEqual([null, null, null, null, null, null]);
    expect(c.durationSec).toBe(1.5);
    expect(normalizeTiktokVideo({ id: "zero", playCount: "0", diggCount: 0, authorMeta: { fans: 0 } })).toMatchObject({ views: 0, likes: 0, authorFollowerCount: 0 });
  });
  it("uses explicit epoch seconds and validates calendar strings before normalization", () => {
    expect(normalizeTiktokVideo({ id: "seconds", createTime: 1_780_387_200 })?.postedAt).toBe("2026-06-02T08:00:00.000Z");
    expect(normalizeInstagramReel({ id: "seconds", taken_at_timestamp: 0 })?.postedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(normalizeInstagramReel({ id: "calendar", timestamp: "2026-02-30T00:00:00Z" })?.postedAt).toBeNull();
    expect(normalizeTiktokVideo({ id: "huge", createTime: Number.MAX_SAFE_INTEGER })?.postedAt).toBeNull();
    expect(normalizeTiktokVideo({ id: "unknown-unit", createTimestamp: 1_780_387_200 })?.postedAt).toBeNull();
  });
  it("keeps missing and impossible source dates through recency filtering without inventing birth", async () => {
    const h = harness(() => ({ items: [{ ...TT_SAMPLE, createTimeISO: "2026-02-30T00:00:00Z" },
      { ...TT_SAMPLE, id: "missing", createTimeISO: undefined }] }));
    const clips = await h.client.creatorReels({ platform: "tiktok", handle: "source", sinceISO: "2026-06-01T00:00:00Z" });
    expect(clips.map(c => c.postedAt)).toEqual([null, null]);
  });
});

describe("creatorReels", () => {
  it("calls the IG actor with a profile directUrl + posts resultsType", async () => {
    const h = harness(() => ({ items: [IG_SAMPLE] }));
    const clips = await h.client.creatorReels({ platform: "instagram", handle: "@ChrisDoesViral", maxItems: 10 });
    expect(h.startUrl()).toContain(`/v2/acts/${INSTAGRAM_ACTOR_ID}/runs`);
    expect(h.startUrl()).toContain("token=apify_api_test");
    expect(h.body().directUrls).toEqual(["https://www.instagram.com/ChrisDoesViral/"]);
    expect(h.body().resultsType).toBe("posts");
    expect(h.body().resultsLimit).toBe(10);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.authorHandle).toBe("chrisdoesviral");
  });

  it("calls the TikTok actor with a profiles array", async () => {
    const h = harness(() => ({ items: [TT_SAMPLE] }));
    const clips = await h.client.creatorReels({ platform: "tiktok", handle: "growthnerd", maxItems: 5 });
    expect(h.startUrl()).toContain(`/v2/acts/${TIKTOK_ACTOR_ID}/runs`);
    expect(h.body().profiles).toEqual(["growthnerd"]);
    expect(h.body().resultsPerPage).toBe(5);
    expect(clips[0]!.platform).toBe("tiktok");
  });

  it("drops clips older than sinceISO + dedupes by id", async () => {
    const h = harness(() => ({ items: [IG_SAMPLE, IG_SAMPLE] })); // IG_SAMPLE = 2026-06-01
    const dropped = await h.client.creatorReels({ platform: "instagram", handle: "x", sinceISO: "2026-06-15T00:00:00Z" });
    expect(dropped).toHaveLength(0);
    const kept = await h.client.creatorReels({ platform: "instagram", handle: "x", sinceISO: "2026-05-01T00:00:00Z" });
    expect(kept).toHaveLength(1); // deduped despite two copies
  });

  it("propagates a 402 as an ApifyError (quota surfaces, not swallowed)", async () => {
    const h = harness(() => ({ status: 402, text: "Monthly usage hard limit exceeded" }));
    await expect(h.client.creatorReels({ platform: "instagram", handle: "x" })).rejects.toBeInstanceOf(ApifyError);
    await expect(h.client.creatorReels({ platform: "instagram", handle: "x" })).rejects.toMatchObject({ status: 402 });
  });

  it("requires a handle", async () => {
    const h = harness(() => ({ items: [] }));
    await expect(h.client.creatorReels({ platform: "instagram", handle: "" })).rejects.toBeInstanceOf(ApifyError);
  });

  it("honours actor id overrides", async () => {
    // Return a clip so the primary wins and we don't fall through to coderx.
    const h = harness(() => ({ items: [IG_SAMPLE] }), { instagramActorId: "me~custom-ig" });
    await h.client.creatorReels({ platform: "instagram", handle: "x" });
    expect(h.startUrl()).toContain("/v2/acts/me~custom-ig/");
  });
});

describe("instagram fallback chain", () => {
  // A coderx profile item: posts nested under latestPosts, follower count on the
  // profile, snake_case video_view_count.
  const CODERX_PROFILE = {
    username: "andrescontrerasofficial",
    followersCount: 183_000,
    latestPosts: [
      {
        shortCode: "DMYDLYiRM2I",
        url: "https://www.instagram.com/p/DMYDLYiRM2I",
        caption: "build in public day 42",
        productType: "clips",
        likesCount: 3_906,
        commentsCount: 298,
        video_view_count: 120_000,
        timestamp: "2026-06-20T16:03:03.000Z",
      },
    ],
  };

  it("falls through to coderx when the primary returns no usable clips (IG-block)", async () => {
    // Primary 201s with an error item (the real IG-block shape) -> 0 clips.
    const blocked = { error: "no_items", errorDescription: "Empty or private data for provided input" };
    const h = harness((url) =>
      url.includes(INSTAGRAM_FALLBACK_ACTOR_ID) ? { items: [CODERX_PROFILE] } : { items: [blocked] },
    );
    const clips = await h.client.creatorReels({ platform: "instagram", handle: "andrescontrerasofficial" });
    expect(clips).toHaveLength(1);
    expect(clips[0]!.id).toBe("DMYDLYiRM2I");
    expect(clips[0]!.views).toBe(120_000); // snake_case video_view_count read
    expect(clips[0]!.likes).toBe(3_906);
    expect(clips[0]!.authorHandle).toBe("andrescontrerasofficial");
    expect(clips[0]!.authorFollowerCount).toBe(183_000); // grafted from profile
  });

  it("falls through to coderx after a confirmed terminal primary actor failure", async () => {
    const h = harness((url) =>
      url.includes(INSTAGRAM_FALLBACK_ACTOR_ID) ? { items: [CODERX_PROFILE] } : { runStatus: "FAILED" },
    );
    const clips = await h.client.creatorReels({ platform: "instagram", handle: "andrescontrerasofficial" });
    expect(clips).toHaveLength(1);
    expect(clips[0]!.id).toBe("DMYDLYiRM2I");
  });

  it("does NOT use coderx for the hashtag/niche lane (username-only)", async () => {
    const urls: string[] = [];
    const h = harness((url) => {
      urls.push(url);
      return { items: [] };
    });
    await h.client.hashtagReels({ platform: "instagram", query: "#aifounders" });
    expect(urls.every((u) => !u.includes(INSTAGRAM_FALLBACK_ACTOR_ID))).toBe(true);
  });

  it("surfaces a token-fatal error before dispatching another provider", async () => {
    let attempts = 0;
    const h = harness(() => { attempts++; return { status: 402, text: "Monthly usage hard limit exceeded" }; });
    await expect(
      h.client.creatorReels({ platform: "instagram", handle: "x" }),
    ).rejects.toMatchObject({ status: 402 });
    expect(attempts).toBe(1);
  });
});

describe("hashtagReels", () => {
  // A search/hashtag-actor item that is a PHOTO (no video fields) — must be
  // dropped by the video-only filter so Nova never studies a still image.
  const IG_PHOTO = {
    id: "p-9001",
    shortCode: "Cphoto1",
    type: "Image",
    caption: "carousel of quotes",
    ownerUsername: "quotemachine",
    likesCount: 12_000,
    commentsCount: 80,
    displayUrl: "https://scontent.cdninstagram.com/photo.jpg",
    timestamp: "2026-06-02T12:00:00.000Z",
  };

  it("hits the keyword/search discovery actor first (not the blocked general scraper)", async () => {
    const h = harness(() => ({ items: [IG_SAMPLE] }));
    const clips = await h.client.hashtagReels({ platform: "instagram", query: "#aifounders", maxItems: 8 });
    expect(h.startUrl()).toContain(`/v2/acts/${INSTAGRAM_SEARCH_ACTOR_ID}/`);
    expect(h.body().search).toBe("aifounders"); // leading # stripped
    expect(h.body().searchType).toBe("popular");
    expect(h.body().searchLimit).toBe(8);
    expect(clips).toHaveLength(1);
  });

  it("falls through to the hashtag actor when the search feed has no reels", async () => {
    const urls: string[] = [];
    const h = harness((url) => {
      urls.push(url);
      // search actor returns only a photo (filtered out) -> fall through.
      if (url.includes(INSTAGRAM_SEARCH_ACTOR_ID)) return { items: [IG_PHOTO] };
      if (url.includes(INSTAGRAM_HASHTAG_ACTOR_ID)) return { items: [IG_SAMPLE] };
      return { items: [] };
    });
    const clips = await h.client.hashtagReels({ platform: "instagram", query: "aifounders" });
    expect(urls.some((u) => u.includes(INSTAGRAM_SEARCH_ACTOR_ID))).toBe(true);
    expect(urls.some((u) => u.includes(INSTAGRAM_HASHTAG_ACTOR_ID))).toBe(true);
    expect(h.body().resultsType).toBe("reels");
    expect(clips).toHaveLength(1);
    expect(clips[0]!.id).toBe("3001");
  });

  it("drops photo items from the discovery feed (video-only)", async () => {
    // Only the discovery actors return the photo; every actor's photo is filtered
    // by igVideoItems, so the chain yields nothing rather than studying a still.
    const h = harness((url) =>
      url.includes(INSTAGRAM_SEARCH_ACTOR_ID) || url.includes(INSTAGRAM_HASHTAG_ACTOR_ID)
        ? { items: [IG_PHOTO] }
        : { items: [] },
    );
    const clips = await h.client.hashtagReels({ platform: "instagram", query: "quotes" });
    expect(clips).toHaveLength(0);
  });

  it("falls back to the general scraper via explore/tags + reels when both discovery actors are empty", async () => {
    const urls: string[] = [];
    const h = harness((url) => {
      urls.push(url);
      if (url.includes(INSTAGRAM_SEARCH_ACTOR_ID) || url.includes(INSTAGRAM_HASHTAG_ACTOR_ID)) {
        return { items: [] };
      }
      // general scraper (last hashtag resort) returns a reel
      return { items: [IG_SAMPLE] };
    });
    const clips = await h.client.hashtagReels({ platform: "instagram", query: "YC Founders", maxItems: 8 });
    // reached the general scraper, driven by the explore/tags URL (space-stripped) + reels
    expect(h.startUrl()).toContain(`/v2/acts/${INSTAGRAM_ACTOR_ID}/`);
    expect(h.body().directUrls).toEqual(["https://www.instagram.com/explore/tags/ycfounders/"]);
    expect(h.body().resultsType).toBe("reels");
    expect(clips).toHaveLength(1);
    expect(clips[0]!.id).toBe("3001");
  });

  it("passes hashtags straight through for tiktok", async () => {
    const h = harness(() => ({ items: [] }));
    await h.client.hashtagReels({ platform: "tiktok", query: "#growth", maxItems: 8 });
    expect(h.startUrl()).toContain(`/v2/acts/${TIKTOK_ACTOR_ID}/`);
    expect(h.body().hashtags).toEqual(["growth"]);
  });

  it("requires a query", async () => {
    const h = harness(() => ({ items: [] }));
    await expect(h.client.hashtagReels({ platform: "tiktok", query: "" })).rejects.toBeInstanceOf(ApifyError);
  });
});

describe("nicheCreatorReels (profile-based niche)", () => {
  it("discovers creators by user-search, then harvests + merges each one's reels", async () => {
    const urls: string[] = [];
    const h = harness((url, body) => {
      urls.push(url);
      // user-search returns two niche accounts
      if (url.includes(INSTAGRAM_SEARCH_ACTOR_ID) && body.searchType === "user") {
        return { items: [{ username: "AiFounderOne" }, { username: "aifoundertwo" }] };
      }
      // creator harvest via the general scraper — one reel per creator, id by handle
      if (url.includes(INSTAGRAM_ACTOR_ID)) {
        const u = String((body.directUrls as string[] | undefined)?.[0] ?? "");
        const id = u.includes("aifounderone") ? "r-1" : "r-2";
        return { items: [{ ...IG_SAMPLE, id, shortCode: id }] };
      }
      return { items: [] };
    });
    const clips = await h.client.nicheCreatorReels({ platform: "instagram", query: "AI founder", maxCreators: 2 });
    expect(urls.some((u) => u.includes(INSTAGRAM_SEARCH_ACTOR_ID))).toBe(true); // did the user-search
    expect(clips.map((c) => c.id).sort()).toEqual(["r-1", "r-2"]); // both creators harvested + merged
  });

  it("falls back to the hashtag lane when profile discovery finds no creators", async () => {

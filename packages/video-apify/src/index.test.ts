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


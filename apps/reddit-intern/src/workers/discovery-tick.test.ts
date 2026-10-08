import { describe, expect, it, vi } from "vitest";
import { runDiscoveryTick } from "./discovery-tick.js";
import { createRepollGate } from "@noelle/runtime/repoll-cooldown";

const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const post = (id: string, opts: { score?: number; numComments?: number; createdAt?: string } = {}) => ({
  id,
  title: `Title ${id}`,
  body: "hello",
  url: `https://www.reddit.com/r/SaaS/comments/${id}/`,
  subreddit: "SaaS",
  createdAt: opts.createdAt ?? "2026-06-08T00:00:00.000Z",
  score: opts.score ?? 12,
  upvoteRatio: 0.95,
  numComments: opts.numComments ?? 3,
  author: { username: "jane_builder" },
});

const sub = {
  id: "ws1",
  subreddit: "SaaS",
  objective: null,
  minScore: 0,
  addedAt: "2026-06-01T00:00:00.000Z",
};

const CAP = 80;

describe("runDiscoveryTick (reddit / apify)", () => {
  it("records failed and empty paid reads, including measured zero and actual credential identity", async () => {
    for (const fails of [false, true]) for (const actualUsd of [0, 0.37]) {
      const record = vi.fn().mockResolvedValue(undefined);
      const postsSource = {
        subredditPosts: async () => { if (fails) throw new Error("dataset failed"); return []; },
        drainRunReceipts: () => [{ runId: "paid", actor: "reddit-posts-comments-scraper", actualUsd,
          status: "SUCCEEDED", terminal: true, credentialId: "actual-token", resultCount: 0,
          resultCountComplete: true, fetchedResultCount: 0 }],
      };
      await runDiscoveryTick({ log, instance: { id: "i", org_id: "o" } as never,
        watchlistSubreddits: [sub], postsSource, discoveryLimit: 5, dailyExtractCap: CAP,
        alreadyExtractedToday: 0, upsertLead: vi.fn(), recorder: { record }, credentialId: "stale-token" });
      expect(record).toHaveBeenCalledOnce();
      expect(record.mock.calls[0]![0]).toMatchObject({ cents: Math.round(actualUsd * 100),
        credentialId: "actual-token", costBasis: "provider_reported", model: "apify/reddit-posts-comments-scraper" });
    }
  });

  it.each([0, 1])("preserves unknown measurements and respects an explicit score floor of %s", async (minScore) => {
    const upsertLead = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const unknown = { ...post("unknown"), score: null, numComments: null };
    await runDiscoveryTick({ log, instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [{ ...sub, minScore }],
      postsSource: { subredditPosts: async () => [unknown, post("zero", { score: 0, numComments: 0 }), post("negative", { score: -2 })] },
      discoveryLimit: 5, dailyExtractCap: CAP, alreadyExtractedToday: 0, upsertLead });
    if (minScore > 0) expect(upsertLead).not.toHaveBeenCalled();
    else {
      expect(upsertLead).toHaveBeenCalledTimes(3);
      expect(upsertLead.mock.calls[0]![0].payload).toMatchObject({ score: null, numComments: null });
      expect(upsertLead.mock.calls[1]![0].payload).toMatchObject({ score: 0, numComments: 0 });
      expect(upsertLead.mock.calls[2]![0].payload.score).toBe(-2);
    }
  });

  it.each(["", "2026-02-30T12:00:00Z", "2026-10-05T12:34:56.000Z"])("preserves measured source time or explicit unknown: %s", async (createdAt) => {
    const upsertLead = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    await runDiscoveryTick({
      log, instance: { id: "i", org_id: "o" } as never, watchlistSubreddits: [sub],
      postsSource: { subredditPosts: async () => [post("date", { createdAt })] },
      discoveryLimit: 5, dailyExtractCap: CAP, alreadyExtractedToday: 0, upsertLead,
    });
    expect(upsertLead).toHaveBeenCalledOnce();
    const expected = createdAt === "2026-10-05T12:34:56.000Z" ? createdAt : null;
    expect(upsertLead.mock.calls[0]![0]).toMatchObject({ postedAt: expected, payload: { postedAt: expected } });
  });

  it("records the Apify subredditPosts spend as engine='apify' (worker 'discovery')", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const subredditPosts = vi.fn().mockResolvedValue([post("1"), post("2"), post("3")]);
    const record = vi.fn().mockResolvedValue(undefined);
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [sub],
      postsSource: { subredditPosts, drainLastRunUsd: () => 0.37 },
      discoveryLimit: 15,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
      recorder: { record },
    });
    const apifyRows = record.mock.calls.map((c) => c[0]).filter((r) => r.engine === "apify");
    expect(apifyRows).toHaveLength(1);
    expect(apifyRows[0]!.worker).toBe("discovery");
    expect(apifyRows[0]!.model).toBe("apify/reddit-posts-comments-scraper");
    expect(apifyRows[0]!.cents).toBe(37);
  });

  it("upserts each post as a NEW, UNCLASSIFIED reddit lead (priority=false, author=username, authorId=null)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const subredditPosts = vi.fn().mockResolvedValue([post("1"), post("2")]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [sub],
      postsSource: { subredditPosts },
      discoveryLimit: 15,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(inserted).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    const firstCall = upsert.mock.calls[0]![0];
    expect(firstCall.platform).toBe("reddit");
    expect(firstCall.externalId).toBe("1");
    expect(firstCall.authorHandle).toBe("jane_builder");
    expect(firstCall.authorId).toBeNull();
    expect(firstCall.priority).toBe(false);
    // payload carries title/text/url/subreddit/score/numComments.
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          title: "Title 1",
          text: "hello",
          subreddit: "SaaS",
          score: 12,
          numComments: 3,
        }),
      }),
    );
  });

  it("carries images + topComments onto the lead payload and forwards commentsPerPost", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const withMedia = {
      ...post("m1"),
      images: ["https://i.redd.it/x.jpg"],
      topComments: [{ id: "c1", body: "top take", score: 90, author: "u1", permalink: "https://www.reddit.com/r/SaaS/comments/m1/c/c1/" }],
    };
    const subredditPosts = vi.fn().mockResolvedValue([withMedia]);

    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [sub],
      postsSource: { subredditPosts },
      discoveryLimit: 15,
      commentsPerPost: 12,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(subredditPosts).toHaveBeenCalledWith(expect.objectContaining({ commentsPerPost: 12 }));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          images: ["https://i.redd.it/x.jpg"],
          topComments: [{ id: "c1", body: "top take", score: 90, author: "u1", permalink: "https://www.reddit.com/r/SaaS/comments/m1/c/c1/" }],
        }),
      }),
    );
  });

  it("defaults images/topComments to [] when a post has none", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const subredditPosts = vi.fn().mockResolvedValue([post("plain")]);
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [sub],
      postsSource: { subredditPosts },
      discoveryLimit: 15,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ images: [], topComments: [] }) }),
    );
  });

  it("drops posts below the subreddit's score floor", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const lo = post("lo", { score: 3 });
    const hi = post("hi", { score: 40 });
    const subredditPosts = vi.fn().mockResolvedValue([lo, hi]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [{ ...sub, minScore: 10 }],
      postsSource: { subredditPosts },
      discoveryLimit: 15,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(inserted).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "hi" }));
  });

  it("a score floor of 0 never filters (default behaviour)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const subredditPosts = vi.fn().mockResolvedValue([post("a", { score: 0 })]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [{ ...sub, minScore: 0 }],
      postsSource: { subredditPosts },
      discoveryLimit: 15,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(inserted).toBe(1);
  });

  it("is gentle: fetches by subreddit (sort=new) with the limit + added_at as sinceISO", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const subredditPosts = vi.fn().mockResolvedValue([]);

    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [sub],
      postsSource: { subredditPosts },
      discoveryLimit: 15,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(subredditPosts).toHaveBeenCalledWith({
      subreddit: "SaaS",
      sort: "new",
      maxItems: 15,
      sinceISO: "2026-06-01T00:00:00.000Z",
    });
  });

  it("continues to the next subreddit when one fetch throws", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const subredditPosts = vi
      .fn()
      .mockRejectedValueOnce(new Error("apify error"))
      .mockResolvedValueOnce([post("9")]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [sub, { ...sub, id: "ws2", subreddit: "ExperiencedDevs" }],
      postsSource: { subredditPosts },
      discoveryLimit: 15,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(inserted).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "9" }));
  });

  it("does NOT fetch when already at the daily extract cap", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const subredditPosts = vi.fn().mockResolvedValue([post("1")]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [sub],
      postsSource: { subredditPosts },
      discoveryLimit: 15,
      dailyExtractCap: 80,
      alreadyExtractedToday: 80,
      upsertLead: upsert,
    });

    expect(inserted).toBe(0);
    expect(subredditPosts).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("stops inserting mid-tick the moment the running total hits the daily extract cap", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const subredditPosts = vi.fn().mockResolvedValue([post("1"), post("2"), post("3"), post("4"), post("5")]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [sub],
      postsSource: { subredditPosts },
      discoveryLimit: 15,
      dailyExtractCap: 80,
      alreadyExtractedToday: 78,
      upsertLead: upsert,
    });

    expect(inserted).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("only counts genuinely-new inserts (re-seen posts don't burn cap budget)", async () => {
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ id: "L1", inserted: false })
      .mockResolvedValueOnce({ id: "L2", inserted: true });
    const subredditPosts = vi.fn().mockResolvedValue([post("1"), post("2")]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [sub],
      postsSource: { subredditPosts },
      discoveryLimit: 15,
      dailyExtractCap: 80,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(inserted).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("dedupes a crosspost surfaced by two watched subreddits into ONE lead", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const subredditPosts = vi
      .fn()
      .mockResolvedValueOnce([post("dup")])
      .mockResolvedValueOnce([post("dup")]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistSubreddits: [sub, { ...sub, id: "ws2", subreddit: "ExperiencedDevs" }],
      postsSource: { subredditPosts },
      discoveryLimit: 15,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(inserted).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe("watchlist repoll gate (per-subreddit cooldown)", () => {
  const baseArgs = <P, U>(subredditPosts: P, upsert: U) => ({
    log,
    instance: { id: "i", org_id: "o" } as never,
    postsSource: { subredditPosts },
    discoveryLimit: 15,
    dailyExtractCap: CAP,
    alreadyExtractedToday: 0,
    upsertLead: upsert,
  });

  it("skips a subreddit that is not due; a due subreddit is still fetched", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const subredditPosts = vi.fn().mockResolvedValue([post("1")]);
    const gate = createRepollGate(2 * 3600_000, () => 0);
    gate.stamp("saas"); // r/SaaS was polled moments ago (keys are lowercased)
    const other = { ...sub, id: "ws2", subreddit: "ExperiencedDevs" };

    await runDiscoveryTick({
      ...baseArgs(subredditPosts, upsert),
      watchlistSubreddits: [sub, other],
      repollGate: gate,
    });

    expect(subredditPosts).toHaveBeenCalledTimes(1);
    expect(subredditPosts).toHaveBeenCalledWith(expect.objectContaining({ subreddit: "ExperiencedDevs" }));
  });

  it("stamps a subreddit on attempt, so the next tick within the window skips it", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const subredditPosts = vi.fn().mockResolvedValue([post("1")]);
    const gate = createRepollGate(2 * 3600_000, () => 0);

    await runDiscoveryTick({ ...baseArgs(subredditPosts, upsert), watchlistSubreddits: [sub], repollGate: gate });
    await runDiscoveryTick({ ...baseArgs(subredditPosts, upsert), watchlistSubreddits: [sub], repollGate: gate });

    expect(subredditPosts).toHaveBeenCalledTimes(1);
  });

  it("stamps even when the subreddit's fetch throws (a failing subreddit is not re-hammered)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const subredditPosts = vi.fn().mockRejectedValue(new Error("apify error"));
    const gate = createRepollGate(2 * 3600_000, () => 0);

    await runDiscoveryTick({ ...baseArgs(subredditPosts, upsert), watchlistSubreddits: [sub], repollGate: gate });

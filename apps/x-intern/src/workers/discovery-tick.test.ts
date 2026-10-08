import { describe, expect, it, vi } from "vitest";
import { runDiscoveryTick } from "./discovery-tick.js";
import { AllApifyTokensExhaustedError } from "../lib/apify-rotating.js";

// The Apify-backed X client returns { tweets, resultCount } (resultCount is the
// raw item count Apify billed for, which drives spend metering). This wraps a
// tweet array into that shape for the mocks.
const res = (tweets: unknown[]) => ({ tweets, resultCount: tweets.length });

describe("runDiscoveryTick", () => {
  it.each(["", "2026-02-30T12:00:00Z", "2026-10-05T12:34:56.000Z"])("preserves measured source time or explicit unknown: %s", async (created_at) => {
    const upsertLead = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const tweet = { id: "123", text: "A useful source", created_at,
      author: { handle: "builder", id: "456", followers: 100 }, url: "https://x.com/builder/status/123" };
    await runDiscoveryTick({
      log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      instance: { id: "i", org_id: "o" }, watchlist: { handles: ["builder"], keywords: [] }, watchlistPeople: [],
      xClient: { userTweets: async () => res([tweet]) } as never,
      upsertLead, rateBucket: { tryTake: () => true },
    });
    expect(upsertLead).toHaveBeenCalledOnce();
    expect(upsertLead.mock.calls[0]![0].postedAt).toBe(created_at === "2026-10-05T12:34:56.000Z" ? created_at : null);
  });

  it("records an actual positive Apify charge even when no result rows were fetched", async () => {
    const recorder = { record: vi.fn().mockResolvedValue(undefined) };
    await runDiscoveryTick({
      log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      instance: { id: "i", org_id: "o" }, watchlist: { handles: ["builder"], keywords: [] }, watchlistPeople: [],
      xClient: { userTweets: async () => ({ tweets: [], resultCount: 0, resultCountComplete: false }),
        drainLastRunUsd: () => 0.37 } as never,
      upsertLead: async () => ({ id: "unused", inserted: false }), rateBucket: { tryTake: () => true }, recorder,
    });
    expect(recorder.record).toHaveBeenCalledWith(expect.objectContaining({ engine: "apify", cents: 37 }));
  });

  it("warns about unknown spend instead of recording a partial result count as the full estimate", async () => {
    const recorder = { record: vi.fn().mockResolvedValue(undefined) };
    const warn = vi.fn();
    await runDiscoveryTick({
      log: { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() } as never,
      instance: { id: "i", org_id: "o" }, watchlist: { handles: ["builder"], keywords: [] }, watchlistPeople: [],
      xClient: { userTweets: async () => ({ tweets: [], resultCount: 100, resultCountComplete: false, fetchedResultCount: 100 }),
        drainLastRunUsd: () => null } as never,
      upsertLead: async () => ({ id: "unused", inserted: false }), rateBucket: { tryTake: () => true }, recorder,
    });
    expect(recorder.record).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ worker: "discovery", fetchedResultCount: 100 }),
      expect.stringContaining("spend unknown"));
  });

  it("deduplicates overlapping sources while preserving each paid run's count", async () => {
    const tweet = { id: "123", text: "A useful question", created_at: "2026-10-05T10:00:00Z",
      author: { handle: "builder", id: "456", followers: 100 }, url: "https://x.com/builder/status/123" };
    const saved: string[] = [];
    const recorder = { record: vi.fn().mockResolvedValue(undefined) };
    const inserted = await runDiscoveryTick({
      log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["builder"], keywords: ["builders"] }, watchlistPeople: [],
      xClient: { userTweets: async () => ({ tweets: [tweet], resultCount: 100 }),
        searchTimeline: async () => ({ tweets: [tweet], resultCount: 200 }) } as never,
      upsertLead: async ({ externalId }) => { saved.push(externalId); return { id: externalId, inserted: true }; },
      rateBucket: { tryTake: () => true }, recorder,
    });
    expect(saved).toEqual(["123"]);
    expect(inserted).toBe(1);
    expect(recorder.record.mock.calls.map(([row]) => row.cents)).toEqual([3, 5]);
  });

  it("interleaves distinct posts from handle and keyword sources before saving", async () => {
    const tweet = (id: string) => ({ id, text: `Post ${id}`, created_at: "2026-10-05T10:00:00Z",
      author: { handle: "builder", id: "456", followers: 100 }, url: `https://x.com/builder/status/${id}` });
    const saved: string[] = [];
    await runDiscoveryTick({
      log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["builder"], keywords: ["builders"] }, watchlistPeople: [],
      xClient: { userTweets: async () => res([tweet("1"), tweet("2")]),
        searchTimeline: async () => res([tweet("3"), tweet("4")]) } as never,
      upsertLead: async ({ externalId }) => { saved.push(externalId); return { id: externalId, inserted: true }; },
      rateBucket: { tryTake: () => true },
    });
    expect(saved).toEqual(["1", "3", "2", "4"]);
  });

  it("makes no Apify reply-lead requests after browser discovery cutover", async () => {
    const xClient = { userTweets: vi.fn(), searchTimeline: vi.fn() };
    const upsertLead = vi.fn();
    const inserted = await runDiscoveryTick({
      log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["u"], keywords: ["agents"] },
      watchlistPeople: [{ handle: "u", addedAt: "2026-09-01T00:00:00Z" }],
      xClient: xClient as never,
      upsertLead,
      rateBucket: { tryTake: () => true },
      apifyReplyLeadsEnabled: false,
    });
    expect(inserted).toBe(0);
    expect(xClient.userTweets).not.toHaveBeenCalled();
    expect(xClient.searchTimeline).not.toHaveBeenCalled();
    expect(upsertLead).not.toHaveBeenCalled();
  });

  it("upserts every tweet returned by userTweets for each handle", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(
        res([
          { id: "1", text: "hi", created_at: "2026-05-18T00:00:00.000Z", author: { handle: "u", id: "uid", followers: 100 }, url: "https://x.com/u/status/1" },
        ]),
      ),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["u"], keywords: [] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ priority: false }));
    // Follower count is stored under the canonical `author_followers` key.
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ author_followers: 100 }) }),
    );
    expect(inserted).toBe(1);
  });

  // A dead pool is SYSTEMIC: every remaining source would fail identically, and
  // swallowing it per-source made the worker's own AllApifyTokensExhaustedError
  // handler unreachable — so discovery could sit dead for a day with no errored
  // run and no alert (#494). The error must escape the tick.
  it("re-throws AllApifyTokensExhaustedError from the HANDLE lane instead of swallowing it", async () => {
    const xClient = {
      userTweets: vi.fn().mockRejectedValue(new AllApifyTokensExhaustedError(52, "all spent")),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await expect(
      runDiscoveryTick({
        log,
        instance: { id: "i", org_id: "o" },
        watchlist: { handles: ["u"], keywords: [] },
        watchlistPeople: [],
        xClient: xClient as never,
        upsertLead: vi.fn().mockResolvedValue({ id: "L", inserted: true }),
        rateBucket: { tryTake: () => true },
      }),
    ).rejects.toBeInstanceOf(AllApifyTokensExhaustedError);
  });

  it("re-throws AllApifyTokensExhaustedError from the KEYWORD lane too", async () => {
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(res([])),
      searchTimeline: vi.fn().mockRejectedValue(new AllApifyTokensExhaustedError(52, "all spent")),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await expect(
      runDiscoveryTick({
        log,
        instance: { id: "i", org_id: "o" },
        watchlist: { handles: [], keywords: ["agents"] },
        watchlistPeople: [],
        xClient: xClient as never,
        upsertLead: vi.fn().mockResolvedValue({ id: "L", inserted: true }),
        rateBucket: { tryTake: () => true },
      }),
    ).rejects.toBeInstanceOf(AllApifyTokensExhaustedError);
  });

  it("PERSISTS leads already fetched before the pool died, then re-throws", async () => {
    // Those tweets were paid for and metered and their handles are already on the
    // re-poll cooldown; unwinding straight out would bin them and re-buy them.
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      userTweets: vi
        .fn()
        .mockResolvedValueOnce(
          res([
            { id: "1", text: "hi", created_at: "2026-05-18T00:00:00.000Z", author: { handle: "a", id: "aid", followers: 5000 }, url: "https://x.com/a/status/1" },
          ]),
        )
        .mockRejectedValue(new AllApifyTokensExhaustedError(52, "all spent")),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await expect(
      runDiscoveryTick({
        log,
        instance: { id: "i", org_id: "o" },
        watchlist: { handles: ["a", "b"], keywords: [] },
        watchlistPeople: [],
        xClient: xClient as never,
        upsertLead: upsert,
        rateBucket: { tryTake: () => true },
      }),
    ).rejects.toBeInstanceOf(AllApifyTokensExhaustedError);
    // The already-fetched lead was saved BEFORE the error surfaced.
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("still swallows an ORDINARY per-source error and keeps polling the rest", async () => {
    // Only a dead pool is systemic; one bad handle must not kill the tick.
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      userTweets: vi
        .fn()
        .mockRejectedValueOnce(new Error("actor 500"))
        .mockResolvedValue(
          res([
            { id: "2", text: "hi", created_at: "2026-05-18T00:00:00.000Z", author: { handle: "b", id: "bid", followers: 100 }, url: "https://x.com/b/status/2" },
          ]),
        ),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["a", "b"], keywords: [] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    expect(inserted).toBe(1); // handle "b" still polled after "a" failed
  });

  it("stops issuing Apify runs once the tick budget is spent, deferring the rest", async () => {
    // Regression for the 10+ min "hung worker": a pool of slow/queued free-tier
    // tokens made one tick spend N × the per-run timeout. The budget caps the tick.
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: false });
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(res([])),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const warn = vi.fn();
    const log = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() } as never;
    // clock: deadline calc=0 (⇒ deadline 100); handle "a" check=10 (under, runs);
    // handle "b" check=200 (over ⇒ defer); keyword "k1" check=200 (over ⇒ defer).
    const times = [0, 10, 200, 200, 200, 200];
    let i = 0;
    const clockNow = () => times[Math.min(i++, times.length - 1)]!;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["a", "b"], keywords: ["k1"] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      budgetMs: 100,
      clockNow,
    });
    // Only the first handle ran before the budget was spent; B + the keyword deferred.
    expect(xClient.userTweets).toHaveBeenCalledTimes(1);
    expect(xClient.userTweets).toHaveBeenCalledWith(expect.objectContaining({ handle: "a" }));
    expect(xClient.searchTimeline).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ deferredHandles: 1, deferredKeywords: 1 }),
      expect.stringContaining("time budget"),
    );
  });

  it("polls every source when no budget is set (legacy, unbounded)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: false });
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(res([])),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const warn = vi.fn();
    const log = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["a", "b"], keywords: ["k1", "k2"] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      // no budgetMs ⇒ deadline Infinity ⇒ nothing deferred
    });
    expect(xClient.userTweets).toHaveBeenCalledTimes(2);
    expect(xClient.searchTimeline).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("time budget"),
    );
  });

  it("records Apify spend per call when a recorder is provided", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(
        res([
          { id: "1", text: "hi", created_at: "2026-05-18T00:00:00.000Z", author: { handle: "u", id: "uid", followers: 100 }, url: "u" },
        ]),
      ),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const recorder = { record: vi.fn().mockResolvedValue(undefined) };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["u"], keywords: [] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      recorder: recorder as never,
      credentialId: "cred-1",
    });
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "apify",
        model: "apify/twitter-x-data-tweet-scraper",
        worker: "discovery",
        credentialId: "cred-1",
      }),
    );
  });

  it("does not record spend for an empty (free) run", async () => {
    const upsert = vi.fn();
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(res([])),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const recorder = { record: vi.fn() };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["u"], keywords: [] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      recorder: recorder as never,
    });
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it("skips a handle when the rate bucket is empty", async () => {
    const upsert = vi.fn();
    const xClient = {
      userTweets: vi.fn(),
      searchTimeline: vi.fn(),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["u"], keywords: [] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => false },
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(xClient.userTweets).not.toHaveBeenCalled();
  });

  it("flags priority for a watchlist person's post on/after added_at", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(
        res([
          { id: "1", text: "new", created_at: "2026-05-29T12:00:00.000Z", author: { handle: "Patio11", id: "p", followers: 9 }, url: "u" },
        ]),
      ),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: [], keywords: [] },
      watchlistPeople: [{ handle: "patio11", addedAt: "2026-05-29T00:00:00.000Z" }],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ priority: true }));
  });

  it("does NOT ingest a watchlist person's post made before added_at (backfill is not drafted)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(
        res([
          // pre-added_at post → profiler owns history, discovery must not draft it
          { id: "1", text: "old", created_at: "2026-05-28T00:00:00.000Z", author: { handle: "patio11", id: "p", followers: 9 }, url: "u" },
          // post-added_at post → still ingested as a priority lead
          { id: "2", text: "new", created_at: "2026-05-29T12:00:00.000Z", author: { handle: "patio11", id: "p", followers: 9 }, url: "u" },
        ]),
      ),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: [], keywords: [] },
      watchlistPeople: [{ handle: "patio11", addedAt: "2026-05-29T00:00:00.000Z" }],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    // Only the post-added_at tweet is upserted, as a priority lead.
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "2", priority: true }));
  });

  it("threads the resolved config (limit + time window + search operators) into the X client", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const userTweets = vi.fn().mockResolvedValue(res([]));
    const searchTimeline = vi.fn().mockResolvedValue(res([]));
    const xClient = { userTweets, searchTimeline };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const now = new Date("2026-06-10T12:00:00.000Z");
    await runDiscoveryTick({
      log,
      instance: {
        id: "i",
        org_id: "o",
        discovery_config: { postsPerSource: 40, minFaves: 50 },
        run_config: { timeWindowHours: 6 },
      },
      watchlist: { handles: ["u"], keywords: ["ai agents"] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      now,
    });
    // Handle poll: run-override window + default limit, both applied — plus the
    // server-side operators (replies would be billed then dropped client-side;
    // retweets are always dropped, so both ride the from: query server-side).
    expect(userTweets).toHaveBeenCalledWith({
      handle: "u",
      limit: 40,
      sinceISO: "2026-06-10T06:00:00.000Z",
      excludeReplies: true,
      excludeRetweets: true,
    });
    // Keyword search: limit + sinceISO + the augmented query (min_faves + since_time).
    const call = searchTimeline.mock.calls[0]![0] as { query: string; limit: number; sinceISO?: string };
    expect(call.limit).toBe(40);
    expect(call.sinceISO).toBe("2026-06-10T06:00:00.000Z");
    expect(call.query).toContain("ai agents");
    expect(call.query).toContain("min_faves:50");
    expect(call.query).toContain("since_time:");
  });

  it("polls a handle that is both a targeting handle and a watchlist person only once", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const userTweets = vi.fn().mockResolvedValue(res([]));
    const xClient = {
      userTweets,
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["patio11"], keywords: [] },
      watchlistPeople: [{ handle: "patio11", addedAt: "2026-05-01T00:00:00.000Z" }],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    expect(userTweets).toHaveBeenCalledTimes(1);
  });

  it("still ingests a dual targeting+watchlist handle's pre-added_at post (as a normal lead), not skipping it", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(
        res([
          // pre-added_at post from a handle that is BOTH targeting + watchlist
          { id: "old", text: "older", created_at: "2026-05-28T00:00:00.000Z", author: { handle: "patio11", id: "p", followers: 9 }, url: "u" },
          // post-added_at post → priority
          { id: "new", text: "newer", created_at: "2026-05-29T12:00:00.000Z", author: { handle: "patio11", id: "p", followers: 9 }, url: "u" },
        ]),
      ),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["patio11"], keywords: [] }, // also a targeting handle
      watchlistPeople: [{ handle: "patio11", addedAt: "2026-05-29T00:00:00.000Z" }],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    // both ingested: the old one as a normal (priority:false) targeting lead,
    // the new one as a priority watchlist lead — nothing skipped.
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "old", priority: false }));
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "new", priority: true }));
  });

  it("watchlistOnly: polls only watchlist-person handles and skips keyword search", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const userTweets = vi.fn().mockResolvedValue(res([]));
    const searchTimeline = vi.fn().mockResolvedValue(res([]));
    const xClient = { userTweets, searchTimeline };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["targetHandle"], keywords: ["ai agents"] },
      watchlistPeople: [{ handle: "WatchedPerson", addedAt: "2026-01-01T00:00:00.000Z" }],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      watchlistOnly: true,
    });
    // only the watched person is polled — not the targeting handle
    expect(userTweets).toHaveBeenCalledTimes(1);
    expect(userTweets).toHaveBeenCalledWith(expect.objectContaining({ handle: "watchedperson" }));
    // keyword search is the keyword lane — skipped entirely in watchlist-only mode
    expect(searchTimeline).not.toHaveBeenCalled();
  });

  it("full mode polls targeting handles AND runs keyword search", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const userTweets = vi.fn().mockResolvedValue(res([]));
    const searchTimeline = vi.fn().mockResolvedValue(res([]));
    const xClient = { userTweets, searchTimeline };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["targetHandle"], keywords: ["ai agents"] },
      watchlistPeople: [{ handle: "WatchedPerson", addedAt: "2026-01-01T00:00:00.000Z" }],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    // both the targeting handle and the watched person are polled, plus keywords
    expect(userTweets).toHaveBeenCalledTimes(2);
    expect(searchTimeline).toHaveBeenCalledTimes(1);
  });

  it("drops a repost (is_repost) instead of upserting it — keyword lane", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(res([])),
      searchTimeline: vi.fn().mockResolvedValue(
        res([
          { id: "1", text: 'RT @orig: "great"', created_at: "2026-05-18T00:00:00.000Z", author: { handle: "u", id: "uid", followers: 100 }, url: "u", is_repost: true },
        ]),
      ),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: [], keywords: ["ai agents"] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(inserted).toBe(0);
  });

  it("drops a repost from a watchlist person too — reposts never bypass into the queue", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(
        res([
          // a watched person's repost (priority would normally bypass all filters)
          { id: "rt", text: 'RT @orig: "great"', created_at: "2026-05-29T12:00:00.000Z", author: { handle: "patio11", id: "p", followers: 9 }, url: "u", is_repost: true },
          // their own authored post on the same tick → still ingested as priority
          { id: "own", text: "my own take", created_at: "2026-05-29T13:00:00.000Z", author: { handle: "patio11", id: "p", followers: 9 }, url: "u", is_repost: false },
        ]),
      ),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: [], keywords: [] },
      watchlistPeople: [{ handle: "patio11", addedAt: "2026-05-29T00:00:00.000Z" }],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    // only the authored post is upserted; the repost is dropped despite priority
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "own", priority: true }));
  });

  it("drops a reply (is_reply) by default — both lanes, including a watchlist person", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(
        res([
          // a watched person's REPLY to someone else → dropped (excludeReplies default ON)
          { id: "r", text: "good point, though I'd add…", created_at: "2026-05-29T12:00:00.000Z", author: { handle: "patio11", id: "p", followers: 9 }, url: "u", is_repost: false, is_reply: true },
          // their own top-level post on the same tick → ingested
          { id: "own", text: "here's my own take", created_at: "2026-05-29T13:00:00.000Z", author: { handle: "patio11", id: "p", followers: 9 }, url: "u", is_repost: false, is_reply: false },
        ]),
      ),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: [], keywords: [] },
      watchlistPeople: [{ handle: "patio11", addedAt: "2026-05-29T00:00:00.000Z" }],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "own" }));
  });

  it("keeps replies when excludeReplies is explicitly turned off", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(res([])),
      searchTimeline: vi.fn().mockResolvedValue(
        res([
          { id: "r", text: "replying in a thread", created_at: "2026-05-29T12:00:00.000Z", author: { handle: "u", id: "uid", followers: 100 }, url: "u", is_repost: false, is_reply: true },
        ]),
      ),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o", run_config: { excludeReplies: false } },
      watchlist: { handles: [], keywords: ["ai agents"] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "r" }));
  });

  it("threads tweet.images onto the lead payload when the tweet has media", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      userTweets: vi.fn().mockResolvedValue(
        res([
          {
            id: "1",
            text: "with a chart",
            created_at: "2026-05-18T00:00:00.000Z",
            author: { handle: "u", id: "uid", followers: 100 },
            url: "https://x.com/u/status/1",
            images: ["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"],
          },
        ]),
      ),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["u"], keywords: [] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          images: ["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"],
        }),
      }),
    );
  });

  it("omits the images key on a text-only tweet (no media)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = {
      // The tweet has no images field at all.
      userTweets: vi.fn().mockResolvedValue(
        res([
          { id: "1", text: "just words", created_at: "2026-05-18T00:00:00.000Z", author: { handle: "u", id: "uid", followers: 100 }, url: "https://x.com/u/status/1" },
        ]),
      ),
      searchTimeline: vi.fn().mockResolvedValue(res([])),
    };
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["u"], keywords: [] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
    });
    const payload = upsert.mock.calls[0]![0].payload;
    expect("images" in payload).toBe(false);
  });

  describe("engagement floor (minFaves)", () => {
    const tweet = (over: Record<string, unknown>) => ({
      id: "1",
      text: "hi",
      created_at: "2026-05-18T00:00:00.000Z",
      author: { handle: "u", id: "uid", followers: 100 },
      url: "https://x.com/u/status/1",
      ...over,
    });

    it("drops a post whose like count is below the floor", async () => {
      const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
      const xClient = {
        userTweets: vi.fn().mockResolvedValue(res([tweet({ likes: 12 })])),
        searchTimeline: vi.fn().mockResolvedValue(res([])),
      };
      const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
      const inserted = await runDiscoveryTick({
        log,
        instance: { id: "i", org_id: "o", discovery_config: { minFaves: 50 } },
        watchlist: { handles: ["u"], keywords: [] },
        watchlistPeople: [],
        xClient: xClient as never,
        upsertLead: upsert,
        rateBucket: { tryTake: () => true },
      });
      expect(upsert).not.toHaveBeenCalled();
      expect(inserted).toBe(0);
    });

    it("keeps a post at or above the floor", async () => {
      const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
      const xClient = {
        userTweets: vi.fn().mockResolvedValue(res([tweet({ likes: 50 })])),
        searchTimeline: vi.fn().mockResolvedValue(res([])),
      };
      const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
      await runDiscoveryTick({
        log,
        instance: { id: "i", org_id: "o", discovery_config: { minFaves: 50 } },
        watchlist: { handles: ["u"], keywords: [] },
        watchlistPeople: [],
        xClient: xClient as never,
        upsertLead: upsert,
        rateBucket: { tryTake: () => true },
      });
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    it("never punishes an unknown (null) like count — the server-side operator covers search", async () => {
      const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
      const xClient = {
        // no `likes` field at all → count is unknown
        userTweets: vi.fn().mockResolvedValue(res([tweet({})])),
        searchTimeline: vi.fn().mockResolvedValue(res([])),
      };
      const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
      await runDiscoveryTick({
        log,
        instance: { id: "i", org_id: "o", discovery_config: { minFaves: 50 } },
        watchlist: { handles: ["u"], keywords: [] },
        watchlistPeople: [],
        xClient: xClient as never,
        upsertLead: upsert,
        rateBucket: { tryTake: () => true },
      });
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    // CONTRACT CHANGE: the engagement floor is now a KEYWORD-lane heuristic only.
    // "The person is the gate, not the post" (#185) — a hand-picked person's
    // quiet post is exactly what Vega should answer, and quality is judged
    // downstream by the classifier + the priority clamp's off-topic floor, not by
    // a like count at ingest.
    it("narrows a watch-lane fetch to added_at so Apify is not billed for discards", async () => {
      // Apify bills per item and pre-added_at posts are dropped client-side, so
      // the fetch must ask for max(window, added_at), not the raw window.
      const userTweets = vi.fn().mockResolvedValue(res([]));
      const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
      await runDiscoveryTick({
        log,
        // 168h is the schema maximum; 720 was silently rejected, so the old
        // version of this test only exercised the NO-window branch.
        instance: { id: "i", org_id: "o", discovery_config: { timeWindowHours: 168 } },
        watchlist: { handles: [], keywords: [] },
        watchlistPeople: [
          { handle: "patio11", addedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() },
        ],
        xClient: { userTweets, searchTimeline: vi.fn().mockResolvedValue(res([])) } as never,
        upsertLead: vi.fn().mockResolvedValue({ id: "L", inserted: true }),
        rateBucket: { tryTake: () => true },
      });
      // Must be the added_at (2h ago), not the 168h window.
      const since = (userTweets.mock.calls[0]![0] as { sinceISO?: string }).sinceISO!;
      const ageHours = (Date.now() - new Date(since).getTime()) / 3_600_000;
      expect(ageHours).toBeLessThan(3);
      expect(ageHours).toBeGreaterThan(1);
    });

    it("does NOT narrow a DUAL-ROLE handle (targeting + watchlist) to added_at", async () => {
      // discovery-tick deliberately keeps a dual-role handle's pre-added_at posts
      // as normal non-priority leads; narrowing its fetch would cut exactly that
      // targeting coverage.
      const userTweets = vi.fn().mockResolvedValue(res([]));
      const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
      await runDiscoveryTick({
        log,
        instance: { id: "i", org_id: "o", discovery_config: { timeWindowHours: 168 } },
        watchlist: { handles: ["patio11"], keywords: [] }, // also a targeting handle
        watchlistPeople: [
          { handle: "patio11", addedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() },
        ],
        xClient: { userTweets, searchTimeline: vi.fn().mockResolvedValue(res([])) } as never,
        upsertLead: vi.fn().mockResolvedValue({ id: "L", inserted: true }),
        rateBucket: { tryTake: () => true },
      });
      const since = (userTweets.mock.calls[0]![0] as { sinceISO?: string }).sinceISO!;
      const ageHours = (Date.now() - new Date(since).getTime()) / 3_600_000;
      expect(ageHours).toBeGreaterThan(100); // the full window, not the 2h added_at
    });

    it("keeps the plain window for a targeting handle with no added_at", async () => {
      const userTweets = vi.fn().mockResolvedValue(res([]));
      const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
      await runDiscoveryTick({
        log,
        instance: { id: "i", org_id: "o", discovery_config: { timeWindowHours: 24 } },
        watchlist: { handles: ["someone"], keywords: [] },
        watchlistPeople: [],
        xClient: { userTweets, searchTimeline: vi.fn().mockResolvedValue(res([])) } as never,
        upsertLead: vi.fn().mockResolvedValue({ id: "L", inserted: true }),
        rateBucket: { tryTake: () => true },
      });
      const arg = userTweets.mock.calls[0]![0] as { sinceISO?: string };
      // Still a real 24h window, not widened or dropped.
      expect(arg.sinceISO).toBeTruthy();
      expect(arg.sinceISO).not.toBe("2026-05-29T00:00:00.000Z");
    });

    it("STILL applies the floor to a stranger from the keyword lane", async () => {
      // The floor must keep doing its job where it belongs: trawling strangers.
      const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
      const xClient = {
        userTweets: vi.fn().mockResolvedValue(res([])),
        searchTimeline: vi.fn().mockResolvedValue(
          res([
            tweet({
              id: "10",
              likes: 2,
              created_at: "2026-05-29T12:00:00.000Z",
              author: { handle: "a-stranger", id: "s", followers: 900 },
            }),
          ]),
        ),
      };
      const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
      await runDiscoveryTick({
        log,
        instance: { id: "i", org_id: "o", discovery_config: { minFaves: 50 } },
        watchlist: { handles: [], keywords: ["agents"] },
        watchlistPeople: [],
        xClient: xClient as never,
        upsertLead: upsert,
        rateBucket: { tryTake: () => true },
      });
      expect(upsert).not.toHaveBeenCalled();
    });

    it("does NOT apply the floor to a watchlist person's low-engagement post", async () => {
      const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
      const xClient = {
        userTweets: vi.fn().mockResolvedValue(
          res([
            tweet({
              id: "9",
              likes: 2,
              created_at: "2026-05-29T12:00:00.000Z",
              author: { handle: "patio11", id: "p", followers: 9 },
            }),
          ]),
        ),
        searchTimeline: vi.fn().mockResolvedValue(res([])),
      };
      const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
      await runDiscoveryTick({
        log,
        instance: { id: "i", org_id: "o", discovery_config: { minFaves: 50 } },
        watchlist: { handles: [], keywords: [] },
        watchlistPeople: [{ handle: "patio11", addedAt: "2026-05-29T00:00:00.000Z" }],
        xClient: xClient as never,
        upsertLead: upsert,
        rateBucket: { tryTake: () => true },
      });
      // A 2-like post from a HAND-PICKED person is ingested (as a priority lead)
      // even though minFaves is 50.
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ priority: true }));
    });
  });
});

const { createRepollGate } = await import("@noelle/runtime/repoll-cooldown");
const { createSourceCursorRegistry } = await import("../lib/source-cursor.js");

describe("watch-lane repoll gate (per-handle cooldown)", () => {
  const log = () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) as never;
  const tweet = (id: string, handle: string) => ({
    id,
    text: `post ${id}`,
    created_at: "2026-07-01T00:00:00.000Z",
    author: { handle, id: `${handle}-id`, followers: 10 },
    url: `https://x.com/${handle}/status/${id}`,
  });
  const person = { handle: "jane", addedAt: "2026-06-01T00:00:00.000Z" };
  const baseArgs = (xClient: unknown, upsert: unknown) => ({
    log: log(),
    instance: { id: "i", org_id: "o" } as never,
    watchlist: { handles: [], keywords: [] },
    watchlistPeople: [person],
    xClient: xClient as never,
    upsertLead: upsert as never,
    rateBucket: { tryTake: () => true },
  });

  it("no gate passed ⇒ old behaviour: the person is polled every tick", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = { userTweets: vi.fn().mockResolvedValue(res([tweet("1", "jane")])), searchTimeline: vi.fn().mockResolvedValue(res([])) };
    await runDiscoveryTick(baseArgs(xClient, upsert));
    await runDiscoveryTick(baseArgs(xClient, upsert));
    expect(xClient.userTweets).toHaveBeenCalledTimes(2);
  });

  it("a watch person inside the window is skipped; polled again once it elapses", async () => {
    let now = 0;
    const gate = createRepollGate(3600_000, () => now);
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = { userTweets: vi.fn().mockResolvedValue(res([tweet("1", "jane")])), searchTimeline: vi.fn().mockResolvedValue(res([])) };
    await runDiscoveryTick({ ...baseArgs(xClient, upsert), repollGate: gate });
    await runDiscoveryTick({ ...baseArgs(xClient, upsert), repollGate: gate });
    expect(xClient.userTweets).toHaveBeenCalledTimes(1); // second tick cooled down
    now = 3600_000;
    await runDiscoveryTick({ ...baseArgs(xClient, upsert), repollGate: gate });
    expect(xClient.userTweets).toHaveBeenCalledTimes(2);
  });

  it("a throwing fetch is stamped too (cools down instead of re-hammering)", async () => {
    const gate = createRepollGate(3600_000, () => 0);
    const upsert = vi.fn();
    const xClient = { userTweets: vi.fn().mockRejectedValue(new Error("apify down")), searchTimeline: vi.fn().mockResolvedValue(res([])) };
    await runDiscoveryTick({ ...baseArgs(xClient, upsert), repollGate: gate });
    await runDiscoveryTick({ ...baseArgs(xClient, upsert), repollGate: gate });
    expect(xClient.userTweets).toHaveBeenCalledTimes(1);
  });

  it("an empty rate bucket does NOT stamp (the handle retries next tick)", async () => {
    const gate = createRepollGate(3600_000, () => 0);
    const upsert = vi.fn();
    const xClient = { userTweets: vi.fn().mockResolvedValue(res([])), searchTimeline: vi.fn().mockResolvedValue(res([])) };
    await runDiscoveryTick({ ...baseArgs(xClient, upsert), repollGate: gate, rateBucket: { tryTake: () => false } });
    expect(xClient.userTweets).not.toHaveBeenCalled();
    await runDiscoveryTick({ ...baseArgs(xClient, upsert), repollGate: gate });
    expect(xClient.userTweets).toHaveBeenCalledTimes(1); // still due — no stamp happened
  });

  it("a dual-role handle (targeting + watchlist person) is never gated when the keyword lane is on", async () => {
    const gate = createRepollGate(3600_000, () => 0);
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = { userTweets: vi.fn().mockResolvedValue(res([tweet("1", "jane")])), searchTimeline: vi.fn().mockResolvedValue(res([])) };
    const args = { ...baseArgs(xClient, upsert), watchlist: { handles: ["jane"], keywords: [] }, repollGate: gate };
    await runDiscoveryTick(args);
    await runDiscoveryTick(args);
    expect(xClient.userTweets).toHaveBeenCalledTimes(2); // targeting coverage untouched
  });

  it("in watchlist-only mode a dual-role handle IS gated (the poll is purely watch-lane)", async () => {
    const gate = createRepollGate(3600_000, () => 0);
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = { userTweets: vi.fn().mockResolvedValue(res([tweet("1", "jane")])), searchTimeline: vi.fn().mockResolvedValue(res([])) };
    const args = { ...baseArgs(xClient, upsert), watchlist: { handles: ["jane"], keywords: [] }, repollGate: gate, watchlistOnly: true };
    await runDiscoveryTick(args);
    await runDiscoveryTick(args);
    expect(xClient.userTweets).toHaveBeenCalledTimes(1);
  });

  it("a pure targeting handle (not a watchlist person) is never gated", async () => {
    const gate = createRepollGate(3600_000, () => 0);
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = { userTweets: vi.fn().mockResolvedValue(res([tweet("1", "acme")])), searchTimeline: vi.fn().mockResolvedValue(res([])) };
    const args = { ...baseArgs(xClient, upsert), watchlist: { handles: ["acme"], keywords: [] }, watchlistPeople: [], repollGate: gate };
    await runDiscoveryTick(args);
    await runDiscoveryTick(args);
    expect(xClient.userTweets).toHaveBeenCalledTimes(2);
  });

  it("gate with cooldown 0 is inert (byte-identical to no gate)", async () => {
    const gate = createRepollGate(0, () => 0);
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const xClient = { userTweets: vi.fn().mockResolvedValue(res([tweet("1", "jane")])), searchTimeline: vi.fn().mockResolvedValue(res([])) };
    await runDiscoveryTick({ ...baseArgs(xClient, upsert), repollGate: gate });
    await runDiscoveryTick({ ...baseArgs(xClient, upsert), repollGate: gate });
    expect(xClient.userTweets).toHaveBeenCalledTimes(2);
  });
});

describe("source-ring rotation under the tick budget (sourceCursor)", () => {
  // Regression for the #494 starvation: a budget-truncated tick restarted at the
  // head of the fixed source list every time, so the first ~6 handles ate every
  // tick's budget and the tail + the whole keyword lane never ran at all.
  const log = () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) as never;
  const emptyClient = () => ({
    userTweets: vi.fn().mockResolvedValue(res([])),
    searchTimeline: vi.fn().mockResolvedValue(res([])),
  });
  const mkCursor = () => {
    let v = 0;
    return { get: () => v, set: (n: number) => { v = n; } };
  };
  // A clock that lets exactly `n` sources run under a 100ms budget: call 1 is
  // the deadline calc (t=0), calls 2..n+1 stay at t=10 (under), the rest read
  // t=200 (over ⇒ defer).
  const clockFor = (n: number) => {
    let i = 0;
    return () => {
      i++;
      if (i === 1) return 0;
      return i <= n + 1 ? 10 : 200;
    };
  };

  it("the next tick resumes at the first budget-deferred source instead of the head", async () => {
    const cursor = mkCursor();
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: false });
    const xClient = emptyClient();
    const base = {
      instance: { id: "i", org_id: "o" } as never,
      watchlist: { handles: ["a", "b", "c", "d"], keywords: [] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      budgetMs: 100,
      sourceCursor: cursor,
    };
    await runDiscoveryTick({ ...base, log: log(), clockNow: clockFor(2) });
    await runDiscoveryTick({ ...base, log: log(), clockNow: clockFor(2) });
    await runDiscoveryTick({ ...base, log: log(), clockNow: clockFor(2) });
    const polled = xClient.userTweets.mock.calls.map((c) => (c[0] as { handle: string }).handle);
    // tick 1: a,b — tick 2 resumes: c,d — tick 3 wraps back: a,b
    expect(polled).toEqual(["a", "b", "c", "d", "a", "b"]);
  });

  it("the keyword lane gets its turn in the ring instead of starving behind the handles", async () => {
    const cursor = mkCursor();
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: false });
    const xClient = emptyClient();
    const warn2 = vi.fn();
    const base = {
      instance: { id: "i", org_id: "o" } as never,
      watchlist: { handles: ["h1", "h2"], keywords: ["k1", "k2"] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      budgetMs: 100,
      sourceCursor: cursor,
    };
    await runDiscoveryTick({ ...base, log: log(), clockNow: clockFor(2) });
    await runDiscoveryTick({
      ...base,
      log: { info: vi.fn(), debug: vi.fn(), warn: warn2, error: vi.fn() } as never,
      clockNow: clockFor(2),
    });
    // tick 1 spends its budget on the two handles; tick 2 resumes at the keywords.
    expect(xClient.userTweets).toHaveBeenCalledTimes(2);
    expect(xClient.searchTimeline).toHaveBeenCalledTimes(2);
    const queries = xClient.searchTimeline.mock.calls.map((c) => (c[0] as { query: string }).query);
    expect(queries[0]).toContain("k1");
    expect(queries[1]).toContain("k2");
    // tick 2's deferred tail is the two handles now sitting at the back of the ring.
    expect(warn2).toHaveBeenCalledWith(
      expect.objectContaining({ deferredHandles: 2, deferredKeywords: 0 }),
      expect.stringContaining("time budget"),
    );
  });

  it("without a cursor each tick restarts at the head (legacy behaviour)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: false });
    const xClient = emptyClient();
    const base = {
      instance: { id: "i", org_id: "o" } as never,
      watchlist: { handles: ["a", "b", "c", "d"], keywords: [] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      budgetMs: 100,
    };
    await runDiscoveryTick({ ...base, log: log(), clockNow: clockFor(2) });
    await runDiscoveryTick({ ...base, log: log(), clockNow: clockFor(2) });
    const polled = xClient.userTweets.mock.calls.map((c) => (c[0] as { handle: string }).handle);
    expect(polled).toEqual(["a", "b", "a", "b"]);
  });

  it("a cooled-down handle advances the cursor too (visited, not deferred)", async () => {
    // "a" is inside its repoll window ⇒ skipped for free, but it still counts as
    // visited: the cursor advances past it (and past the three real runs), so
    // the next tick starts at the first source the budget actually deferred.
    const cursor = mkCursor();
    const gate = createRepollGate(3600_000, () => 0);
    gate.stamp("a");
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: false });
    const xClient = emptyClient();
    const base = {
      instance: { id: "i", org_id: "o" } as never,
      watchlist: { handles: [], keywords: [] },
      watchlistPeople: [
        { handle: "a", addedAt: "2026-01-01T00:00:00.000Z" },
        { handle: "b", addedAt: "2026-01-02T00:00:00.000Z" },
        { handle: "c", addedAt: "2026-01-03T00:00:00.000Z" },
        { handle: "d", addedAt: "2026-01-04T00:00:00.000Z" },
        { handle: "e", addedAt: "2026-01-05T00:00:00.000Z" },
      ],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      budgetMs: 100,
      sourceCursor: cursor,
      repollGate: gate,
      watchlistOnly: true,
    };
    await runDiscoveryTick({ ...base, log: log(), clockNow: clockFor(4) });
    expect(xClient.userTweets.mock.calls.map((c) => (c[0] as { handle: string }).handle)).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(cursor.get()).toBe(4); // a(cooled)+b+c+d visited; e deferred ⇒ next tick starts at e
  });

  it("a rate-starved tail is deferred, not swept: the cursor stops at the first rate-skipped source", async () => {
    // When the RATE BUCKET (not the budget) truncates a tick, the skipped tail
    // must be where the next tick resumes — counting rate-skips as visited
    // wrapped the cursor back to its start and recreated head-starves-tail.
    const cursor = mkCursor();
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: false });
    const xClient = emptyClient();
    const bucketFor = (n: number) => {
      let k = 0;
      return { tryTake: () => k++ < n };
    };
    const base = {
      instance: { id: "i", org_id: "o" } as never,
      watchlist: { handles: ["a", "b", "c", "d"], keywords: [] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      sourceCursor: cursor,
    };
    await runDiscoveryTick({ ...base, log: log(), rateBucket: bucketFor(2) });
    expect(cursor.get()).toBe(2); // resumes at c, the first rate-starved source
    await runDiscoveryTick({ ...base, log: log(), rateBucket: bucketFor(2) });
    const polled = xClient.userTweets.mock.calls.map((c) => (c[0] as { handle: string }).handle);
    expect(polled).toEqual(["a", "b", "c", "d"]);
    expect(cursor.get()).toBe(0);
  });

  it("a stale cursor beyond the ring length re-normalizes (mod) and still rotates", async () => {
    // Reachable when the ring shrinks between ticks (watchlist edits, mode
    // shape changes): the stored value must be re-normalized, not overflow
    // slice() into a silent head-restart.
    const cursor = mkCursor();
    cursor.set(7);
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: false });
    const xClient = emptyClient();
    await runDiscoveryTick({
      log: log(),
      instance: { id: "i", org_id: "o" } as never,
      watchlist: { handles: ["a", "b", "c"], keywords: [] },
      watchlistPeople: [],
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      sourceCursor: cursor,
    });
    const polled = xClient.userTweets.mock.calls.map((c) => (c[0] as { handle: string }).handle);
    expect(polled).toEqual(["b", "c", "a"]); // 7 % 3 = 1 ⇒ starts at b
    expect(cursor.get()).toBe(1); // full pass wraps back to the normalized offset
  });

  it("per-mode cursors: a watchlist-only tick doesn't clamp full-mode rotation (keyword lane still reached)", async () => {
    // The worker keys cursors by (instance, mode) via createSourceCursorRegistry:
    // watchlist-only ticks iterate a people-only ring and re-mod the stored value
    // by THEIR length, so sharing one cursor across modes would clamp full-mode
    // rotation to the head and starve the keyword lane all over again.
    const reg = createSourceCursorRegistry();
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: false });
    const xClient = emptyClient();
    const people = [{ handle: "p1", addedAt: "2026-01-01T00:00:00.000Z" }];
    const wl = { handles: ["h1", "h2"], keywords: ["k1"] };
    const fullTick = () =>
      runDiscoveryTick({
        log: log(),
        instance: { id: "i", org_id: "o" } as never,
        watchlist: wl,
        watchlistPeople: people,
        xClient: xClient as never,
        upsertLead: upsert,
        rateBucket: { tryTake: () => true },
        budgetMs: 100,
        clockNow: clockFor(2),
        sourceCursor: reg.for("i", "full"),
      });
    // full ring [h1, h2, p1, k1]; capacity 2 ⇒ tick 1 polls h1,h2
    await fullTick();
    // a watchlist-only tick in between (paused / caps tripped) — its own 1-source ring
    await runDiscoveryTick({
      log: log(),
      instance: { id: "i", org_id: "o" } as never,
      watchlist: wl,
      watchlistPeople: people,
      xClient: xClient as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      watchlistOnly: true,
      sourceCursor: reg.for("i", "watchlist"),
    });
    // the next full tick must resume at p1,k1 — the keyword lane is reached
    await fullTick();
    expect(xClient.searchTimeline).toHaveBeenCalledTimes(1);
  });
});

describe("person-first lane (candidate retention + polling)", () => {
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
  const icpGate = { headlineKeywords: ["founder", "devtools"], headlineExcludeKeywords: ["crypto"] };

  const authored = (handle: string, bio: string | null, id = "1") =>
    res([
      {
        id,
        text: "a post",
        created_at: "2026-05-18T00:00:00.000Z",
        author: { handle, id: `${handle}-id`, followers: 5000, ...(bio ? { bio } : {}) },
        url: `https://x.com/${handle}/status/${id}`,
      },
    ]);

  it("retains an author whose BIO matches the ICP", async () => {
    const recordDiscoveredPerson = vi.fn().mockResolvedValue(undefined);
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: [], keywords: ["agents"] },
      watchlistPeople: [],
      xClient: {
        userTweets: vi.fn().mockResolvedValue(res([])),
        searchTimeline: vi.fn().mockResolvedValue(authored("someone", "founder, building devtools")),
      } as never,
      upsertLead: vi.fn().mockResolvedValue({ id: "L", inserted: true }),
      rateBucket: { tryTake: () => true },
      icpGate,
      recordDiscoveredPerson,
    });
    expect(recordDiscoveredPerson).toHaveBeenCalledWith(
      expect.objectContaining({ handle: "someone", bio: "founder, building devtools" }),
    );
  });

  it("does NOT retain an off-ICP author", async () => {
    const recordDiscoveredPerson = vi.fn().mockResolvedValue(undefined);
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: [], keywords: ["agents"] },
      watchlistPeople: [],
      xClient: {
        userTweets: vi.fn().mockResolvedValue(res([])),
        searchTimeline: vi.fn().mockResolvedValue(authored("degen", "crypto trader, NFTs")),
      } as never,
      upsertLead: vi.fn().mockResolvedValue({ id: "L", inserted: true }),
      rateBucket: { tryTake: () => true },
      icpGate,
      recordDiscoveredPerson,
    });
    expect(recordDiscoveredPerson).not.toHaveBeenCalled();
  });

  it("does NOT retain on an UNKNOWN bio — retention fails CLOSED", async () => {
    // The classifier's gate fails open on a missing bio (the actor often omits
    // it) because dropping the lane would be worse. Retention is the opposite
    // trade: a speculative prospect list filled with unvetted handles would
    // spend Apify budget polling strangers.
    const recordDiscoveredPerson = vi.fn().mockResolvedValue(undefined);
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: [], keywords: ["agents"] },
      watchlistPeople: [],
      xClient: {
        userTweets: vi.fn().mockResolvedValue(res([])),
        searchTimeline: vi.fn().mockResolvedValue(authored("nobio", null)),
      } as never,
      upsertLead: vi.fn().mockResolvedValue({ id: "L", inserted: true }),
      rateBucket: { tryTake: () => true },
      icpGate,
      recordDiscoveredPerson,
    });
    expect(recordDiscoveredPerson).not.toHaveBeenCalled();
  });

  it("never retains a WATCHLIST person (the watchlist already holds them)", async () => {
    const recordDiscoveredPerson = vi.fn().mockResolvedValue(undefined);
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: [], keywords: ["agents"] },
      watchlistPeople: [{ handle: "someone", addedAt: "2020-01-01T00:00:00.000Z" }],
      xClient: {
        userTweets: vi.fn().mockResolvedValue(res([])),
        searchTimeline: vi.fn().mockResolvedValue(authored("someone", "founder, building devtools")),
      } as never,
      upsertLead: vi.fn().mockResolvedValue({ id: "L", inserted: true }),
      rateBucket: { tryTake: () => true },
      icpGate,
      recordDiscoveredPerson,
    });
    expect(recordDiscoveredPerson).not.toHaveBeenCalled();
  });

  it("polls retained candidates and their posts become NON-priority leads", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const userTweets = vi.fn().mockResolvedValue(authored("candidate", "founder", "9"));
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: [], keywords: [] },
      watchlistPeople: [],
      xClient: { userTweets, searchTimeline: vi.fn().mockResolvedValue(res([])) } as never,
      upsertLead: upsert,
      rateBucket: { tryTake: () => true },
      discoveredHandles: ["candidate"],
    });
    expect(userTweets).toHaveBeenCalledWith(expect.objectContaining({ handle: "candidate" }));
    // A candidate is NOT hand-picked, so their post is an ordinary lead.
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ priority: false }));
  });

  it("stamps a candidate as polled even when their fetch FAILS (no starvation)", async () => {
    // Otherwise a person whose timeline errors stays at the front of the
    // never-polled queue and is retried every tick forever.
    const onPersonPolled = vi.fn().mockResolvedValue(undefined);
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: [], keywords: [] },
      watchlistPeople: [],
      xClient: {
        userTweets: vi.fn().mockRejectedValue(new Error("actor 500")),
        searchTimeline: vi.fn().mockResolvedValue(res([])),
      } as never,
      upsertLead: vi.fn().mockResolvedValue({ id: "L", inserted: true }),
      rateBucket: { tryTake: () => true },
      discoveredHandles: ["candidate"],
      onPersonPolled,
    });
    expect(onPersonPolled).toHaveBeenCalledWith("candidate");
  });

  it("does not double-poll someone who is BOTH a candidate and a watch person", async () => {
    const userTweets = vi.fn().mockResolvedValue(res([]));
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" },
      watchlist: { handles: ["dup"], keywords: [] },
      watchlistPeople: [],
      xClient: { userTweets, searchTimeline: vi.fn().mockResolvedValue(res([])) } as never,
      upsertLead: vi.fn().mockResolvedValue({ id: "L", inserted: true }),
      rateBucket: { tryTake: () => true },
      discoveredHandles: ["dup"],
    });

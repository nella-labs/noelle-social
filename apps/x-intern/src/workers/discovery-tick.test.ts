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

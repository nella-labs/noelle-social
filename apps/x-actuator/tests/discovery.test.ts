import { describe, expect, it } from "vitest";
import * as discoveryModule from "../src/background/discovery.js";
import { claimReplyBeforeSubmit, discoveryStartDecision, discoveryTargetUrl, discoveryNavigationTarget, dryDiscoveryDue, integratePriorityReady, discoveryBrowseDecision, observationBatch, stampCompletedDiscoveryTarget } from "../src/background/discovery.js";
import { makeRng } from "../src/lib/rng.js";
import { makeSessionPersona } from "../src/lib/session.js";
import type { RunState } from "../src/background/state.js";

function emptyDrain(now: number): RunState {
  return {
    sessionId: "s", epoch: 1, startMs: now - 60_000, windowHours: 1,
    actions: [], targets: { likes: 0, comments: 0, dms: 0 },
    done: { likes: 0, comments: 0, dms: 0 }, commentPool: [], dmPool: [],
    doneDraftIds: [], lastPollMs: now, status: "running", mode: "drain",
    persona: makeSessionPersona(7), warmupSuppressMs: 0,
  };
}

const ready = { comments: [{
  approval_id: "approval-1", draft_id: "draft-1", body: "A thoughtful reply",
  target: { url: "https://x.com/author/status/123" },
}], dms: [] };

const emptyTargetCache = {
  cachedTarget: null,
  cacheTarget: async (_target: unknown) => {},
  discardCachedTarget: async () => {},
  onCacheFailure: () => { throw new Error("unexpected cache failure"); },
};

describe("X browser discovery pacing", () => {
  it("does not interrupt a scheduled send and does not restart on a challenge", () => {
    expect(discoveryStartDecision({ status: "running", mode: "scheduled" }, true)).toBe("defer");
    expect(discoveryStartDecision({ status: "running", mode: "scheduled" }, false)).toBe("start");
    expect(discoveryStartDecision({ status: "running", mode: "drain" }, true)).toBe("keep");
    expect(discoveryStartDecision({ status: "halted-challenge", mode: "drain" }, false)).toBe("blocked");
  });
  it("preserves saved search operators and opens Latest results from the last day", () => {
    expect(discoveryTargetUrl({ kind: "profile", handle: "@jackfriks" })).toBe("https://x.com/jackfriks");
    const result = discoveryTargetUrl({ kind: "keyword", value: "agent tools" }, Date.parse("2026-09-22T16:00:00Z"));
    const search = new URL(result!);
    expect(search.searchParams.get("q")).toBe("agent tools since:2026-09-21");
    expect(search.searchParams.get("f")).toBe("live");
    const existingFloor = new URL(discoveryTargetUrl({ kind: "keyword", value: "agent tools min_faves:2" }, Date.parse("2026-09-22T16:00:00Z"))!);
    expect(existingFloor.searchParams.get("q")).toBe("agent tools min_faves:2 since:2026-09-21");
    expect(discoveryTargetUrl({ kind: "keyword", value: "a".repeat(263) })).not.toBeNull();
    expect(discoveryTargetUrl({ kind: "profile", handle: "../notifications" })).toBeNull();
    expect(discoveryTargetUrl({ kind: "keyword", value: " " })).toBeNull();
  });

  it("builds an empty-result retry from the first topical clause", () => {
    const target = discoveryTargetUrl({
      kind: "keyword",
      value: '("my own agents" OR "custom agents" OR "agent stack") (duct OR glue OR breaking) lang:en -filter:replies min_faves:2',
    }, Date.parse("2026-09-22T16:00:00Z"))!;
    const fallbackBuilder = (discoveryModule as Record<string, unknown>).emptySearchFallbackUrl as
      ((url: string) => string | null) | undefined;
    const result = fallbackBuilder?.(target);

    expect(result).toBe(
      "https://x.com/search?q=(%22my%20own%20agents%22%20OR%20%22custom%20agents%22%20OR%20%22agent%20stack%22)%20lang%3Aen%20-filter%3Areplies%20since%3A2026-09-21&src=typed_query&f=live",
    );
  });

  it("retries a single topical clause when its engagement floor made the search empty", () => {
    const target = discoveryTargetUrl({
      kind: "keyword",
      value: '("solo founder" OR "solopreneur") lang:en -filter:replies min_faves:2',
    }, Date.parse("2026-09-22T16:00:00Z"))!;

    expect(discoveryModule.emptySearchFallbackUrl(target)).toBe(
      "https://x.com/search?q=(%22solo%20founder%22%20OR%20%22solopreneur%22)%20lang%3Aen%20-filter%3Areplies%20since%3A2026-09-21&src=typed_query&f=live",
    );
  });

  it("does not retry a single topical clause when no constraint can be relaxed", () => {
    const target = discoveryTargetUrl({
      kind: "keyword", value: '"solo founder"',
    }, Date.parse("2026-09-22T16:00:00Z"))!;

    expect(discoveryModule.emptySearchFallbackUrl(target)).toBeNull();
  });

  it("does not add a language operator that the saved search omitted", () => {
    const target = discoveryTargetUrl({ kind: "keyword", value: "agentes emprendedores" }, Date.parse("2026-09-22T16:00:00Z"))!;
    const fallbackBuilder = (discoveryModule as Record<string, unknown>).emptySearchFallbackUrl as (url: string) => string | null;

    expect(fallbackBuilder(target)).toBe(
      "https://x.com/search?q=agentes%20since%3A2026-09-21&src=typed_query&f=live",
    );
  });

  it("skips leading X operators before selecting the topical clause", () => {
    const target = discoveryTargetUrl({
      kind: "keyword", value: "lang:es (agentes OR IA) (fundadores OR startups)",
    }, Date.parse("2026-09-22T16:00:00Z"))!;
    const fallbackBuilder = (discoveryModule as Record<string, unknown>).emptySearchFallbackUrl as (url: string) => string | null;

    expect(fallbackBuilder(target)).toBe(
      "https://x.com/search?q=(agentes%20OR%20IA)%20lang%3Aes%20since%3A2026-09-21&src=typed_query&f=live",
    );
  });

  it("reads a dry feed no more than once per 90 seconds", () => {
    expect(dryDiscoveryDue(1000, 90_999)).toBe(false);
    expect(dryDiscoveryDue(1000, 91_000)).toBe(true);
  });

  it("selects a topical target by the first eligible read ten minutes after the previous target", async () => {
    const now = Date.parse("2026-09-22T16:00:00Z");
    let lastSelectedMs = now - 10 * 60_000;
    const result = await discoveryNavigationTarget({
      ...emptyTargetCache,
      nowMs: now,
      lastSelectedMs,
      randomRoll: 0.99,
      fetchTarget: async () => ({ kind: "keyword", value: "agent tools" }),
    });
    expect(result).toBe("https://x.com/search?q=agent%20tools%20since%3A2026-09-21&src=typed_query&f=live");
    expect(lastSelectedMs).toBe(now - 10 * 60_000);
    await stampCompletedDiscoveryTarget({
      outcome: "navigate", targetUrl: result, completedAtMs: now + 12_000,
      commitVisit: async ({ completedAtMs }) => { lastSelectedMs = completedAtMs; },
      onStampFailure: () => { throw new Error("unexpected storage failure"); },
    });
    expect(lastSelectedMs).toBe(now + 12_000);
  });

  it("keeps the random 30% share before the deadline and rejects unavailable targets", async () => {
    const now = Date.parse("2026-09-22T16:00:00Z");
    const lastSelectedMs = now - 60_000;
    const choose = (randomRoll: number, fetchTarget: () => Promise<{ kind: "profile"; handle: string } | null>) =>
      discoveryNavigationTarget({
        ...emptyTargetCache,
        nowMs: now,
        lastSelectedMs,
        randomRoll,
        fetchTarget,
      });
    expect(await choose(0.3, async () => ({ kind: "profile", handle: "jackfriks" }))).toBeNull();
    expect(await choose(0.29, async () => null)).toBeNull();
    expect(await choose(0.29, async () => ({ kind: "profile", handle: "../notifications" }))).toBeNull();
    expect(await choose(0.29, async () => ({ kind: "profile", handle: "jackfriks" }))).toBe("https://x.com/jackfriks");
  });

  it("does not count a selected target when its browser visit fails", async () => {
    const now = Date.parse("2026-09-22T16:00:00Z");
    let lastSelectedMs = now - 10 * 60_000;
    const target = await discoveryNavigationTarget({
      ...emptyTargetCache,
      nowMs: now,
      lastSelectedMs,
      randomRoll: 0.99,
      fetchTarget: async () => ({ kind: "profile", handle: "jackfriks" }),
    });
    expect(target).toBe("https://x.com/jackfriks");
    await stampCompletedDiscoveryTarget({
      outcome: null, targetUrl: target, completedAtMs: now + 12_000,
      commitVisit: async ({ completedAtMs }) => { lastSelectedMs = completedAtMs; },
      onStampFailure: () => { throw new Error("unexpected storage failure"); },
    });
    expect(lastSelectedMs).toBe(now - 10 * 60_000);
  });

  it("retries a failed target visit from session cache without consuming another server target", async () => {
    const now = Date.parse("2026-09-22T16:00:00Z");
    let pendingTarget: unknown = null;
    let fetches = 0;
    const select = (atMs: number) => discoveryNavigationTarget({
      nowMs: atMs,
      lastSelectedMs: now - 11 * 60_000,
      randomRoll: 0.99,
      cachedTarget: pendingTarget,
      fetchTarget: async () => { fetches++; return { kind: "profile" as const, handle: "jackfriks" }; },
      cacheTarget: async (target: unknown) => { pendingTarget = target; },
      discardCachedTarget: async () => { pendingTarget = null; },
      onCacheFailure: () => { throw new Error("unexpected cache failure"); },
    });
    expect(await select(now)).toBe("https://x.com/jackfriks");
    expect(pendingTarget).toEqual({ kind: "profile", handle: "jackfriks" });
    expect(await select(now + 90_000)).toBe("https://x.com/jackfriks");
    expect(fetches).toBe(1);
  });

  it("retries a cached target before its ten-minute deadline even when the random roll declines", async () => {
    const now = Date.parse("2026-09-22T16:00:00Z");
    const result = await discoveryNavigationTarget({
      ...emptyTargetCache,
      nowMs: now, lastSelectedMs: now - 60_000, randomRoll: 0.99,
      cachedTarget: { kind: "profile", handle: "jackfriks" },
      fetchTarget: async () => { throw new Error("a cached retry must not fetch"); },
    });
    expect(result).toBe("https://x.com/jackfriks");
  });

  it("discards a malformed cached target without navigating or fetching early", async () => {
    const now = Date.parse("2026-09-22T16:00:00Z");
    let pendingTarget: unknown = { kind: "profile", handle: "../notifications" };
    let fetches = 0;
    const result = await discoveryNavigationTarget({
      nowMs: now, lastSelectedMs: now - 60_000, randomRoll: 0.99,
      cachedTarget: pendingTarget,
      fetchTarget: async () => { fetches++; return { kind: "profile" as const, handle: "jackfriks" }; },
      cacheTarget: async (target: unknown) => { pendingTarget = target; },
      discardCachedTarget: async () => { pendingTarget = null; },
      onCacheFailure: () => { throw new Error("unexpected cache failure"); },
    });
    expect(result).toBeNull();
    expect(pendingTarget).toBeNull();
    expect(fetches).toBe(0);
  });

  it("does not navigate to a fetched target when its retry cache cannot be stored", async () => {
    let warned = false;
    const result = await discoveryNavigationTarget({
      nowMs: Date.parse("2026-09-22T16:00:00Z"), lastSelectedMs: null, randomRoll: 0.99,
      cachedTarget: null,
      fetchTarget: async () => ({ kind: "profile", handle: "jackfriks" }),
      cacheTarget: async () => { throw new Error("storage unavailable"); },
      discardCachedTarget: async () => {},
      onCacheFailure: () => { warned = true; },
    });
    expect(result).toBeNull();
    expect(warned).toBe(true);
  });

  it("commits the completed visit and pending-cache clear together", async () => {
    const writes: Array<{ completedAtMs: number; pendingTarget: null }> = [];
    await stampCompletedDiscoveryTarget({
      outcome: "navigate", targetUrl: "https://x.com/jackfriks", completedAtMs: 123,
      commitVisit: async (record: { completedAtMs: number; pendingTarget: null }) => { writes.push(record); },
      onStampFailure: () => { throw new Error("unexpected commit failure"); },
    });
    expect(writes).toEqual([{ completedAtMs: 123, pendingTarget: null }]);
  });

  it("keeps the actor running if the completed-visit stamp cannot be stored", async () => {
    let warned = false;
    await stampCompletedDiscoveryTarget({
      outcome: "navigate", targetUrl: "https://x.com/jackfriks", completedAtMs: 123,
      commitVisit: async () => { throw new Error("storage unavailable"); },
      onStampFailure: () => { warned = true; },
    });
    expect(warned).toBe(true);
  });

  it("keeps a queued reply while discovery waits and resumes at 4 of 5", () => {
    const now = 1_000_000;
    const state = emptyDrain(now);
    state.commentPool.push({ approvalId: "approval-1", draftId: "draft-1", body: "Ready", url: "https://x.com/a/status/123" });
    state.actions.push({ kind: "comment", atMs: now + 60_000, executed: false });
    expect(discoveryBrowseDecision({ enabled: true, lastReadMs: now - 90_000, nowMs: now, available: 0 })).toBe("full");
    expect(discoveryBrowseDecision({ enabled: true, lastReadMs: now - 90_000, nowMs: now, available: null })).toBe("unavailable");
    expect(discoveryBrowseDecision({ enabled: true, lastReadMs: now - 89_999, nowMs: now, available: 1 })).toBe("waiting");
    expect(discoveryBrowseDecision({ enabled: true, lastReadMs: now - 90_000, nowMs: now, available: 1 })).toBe("browse");
    expect(discoveryBrowseDecision({ enabled: false, lastReadMs: now, nowMs: now, available: null })).toBe("browse");
    expect(state.commentPool).toHaveLength(1);
    expect(state.actions[0]?.executed).toBe(false);
  });

  it("submits no more than the open slots and keeps overflow for later", () => {
    const posts = Array.from({ length: 14 }, (_, i) => ({ tweetId: String(i), url: `https://x.com/a/status/${i}`, text: `Post ${i}`, authorHandle: "a" }));
    expect(observationBatch(posts, 0)).toEqual([]);
    expect(observationBatch(posts, 1).map((p) => p.tweetId)).toEqual(["0"]);
    expect(observationBatch(posts, 5).map((p) => p.tweetId)).toEqual(["0", "1", "2", "3", "4"]);
    expect(observationBatch(posts, 12)).toHaveLength(12);
    expect(observationBatch(posts, 13)).toHaveLength(12);
  });

  it("wakes a caught-up drain at the next paced slot and deduplicates the approval", () => {
    const now = 1_000_000;
    const state = emptyDrain(now);
    state.lastProgressMs = now - 20_000;
    expect(integratePriorityReady(state, ready, now, makeRng(7))).toBe(1);
    const nextReply = state.actions.find((action) => action.kind === "comment")!;
    expect(nextReply.atMs).toBeGreaterThanOrEqual(now + 43_000);
    expect(nextReply.atMs).toBeLessThanOrEqual(now + 49_000);
    expect(state.commentPool).toHaveLength(1);
    const slots = state.actions.length;
    expect(integratePriorityReady(state, ready, now + 1000, makeRng(8))).toBe(0);
    expect(state.actions).toHaveLength(slots);
  });

  it("does not add a second navigation or write path while a slot is pending", () => {
    const now = 1_000_000;
    const state = emptyDrain(now);
    state.actions.push({ kind: "comment", atMs: now + 30_000, executed: false });
    expect(integratePriorityReady(state, ready, now, makeRng(7))).toBe(1);
    expect(state.actions).toHaveLength(1);
    expect(state.commentPool).toHaveLength(1);
  });

  it("blocks a browser submit when the permanent claim is denied or its response is lost", async () => {
    expect(await claimReplyBeforeSubmit({ claimReply: async () => ({ claimed: true }) }, "a")).toBe(true);
    expect(await claimReplyBeforeSubmit({ claimReply: async () => ({ claimed: false }) }, "a")).toBe(false);
    expect(await claimReplyBeforeSubmit({ claimReply: async () => { throw new Error("connection lost"); } }, "a")).toBe(false);
  });
});

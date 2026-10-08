import { describe, expect, it, vi } from "vitest";

async function scenario(args: { cap: number; lane?: "watch" | "keyword" | "icp"; already?: number; posts?: boolean; poolFailure?: boolean }) {
  vi.resetModules();
  const lane = args.lane ?? "watch";
  const people = ["a", "b", "c"].map(publicId => ({
    id: publicId, publicId, fsdProfileId: publicId, name: "Fixture", headline: "",
    objective: null, addedAt: null,
  }));
  const pool = Array.from({ length: 3 }, (_, i) => ({
    credentialId: `credential-${i}`,
    client: {
      profilePosts: vi.fn(async ({ publicId }: { publicId: string }) => args.posts ? [{
        id: publicId, urn: `urn:li:activity:${publicId}`, text: "Fixture post",
        url: "", postedAt: "", reactions: 0, comments: 0,
        author: { name: "Fixture", publicId, url: null, headline: null },
      }] : []),
      searchPosts: vi.fn(async (_args: unknown) => []),
      searchProfiles: vi.fn(async (_args: unknown) => []),
    },
  }));
  const resolvePool = vi.fn(async () => pool);
  const unavailable = new Error("fixture credential read unavailable");
  if (args.poolFailure) resolvePool.mockRejectedValueOnce(unavailable);
  const upsertLead = vi.fn(async () => ({ id: "lead", inserted: true }));
  const providerCallsAtFinish: number[] = [];
  const finish = vi.fn(async (_args: unknown) => {
    providerCallsAtFinish.push(pool.reduce((count, handle) => count + handle.client.profilePosts.mock.calls.length, 0));
  });
  const errors: unknown[] = [];
  let done!: () => void;
  const completed = new Promise<void>(resolve => { done = resolve; });
  vi.doMock("../env.js", () => ({ loadEnv: () => ({
    WORKER_ID: "test", GCP_PROJECT: "test", LINKEDIN_APIFY_REPLY_LEADS: true,
    LINKEDIN_APIFY_HEALTH_SWEEP_ENABLED: false, LINKEDIN_ACTIVE_HOURS_START: 0,
    LINKEDIN_ACTIVE_HOURS_END: 0, LINKEDIN_TZ_OFFSET_MIN: 0,
    LINKEDIN_DAILY_EXTRACT_CAP: args.cap, LINKEDIN_WATCHLIST_DAILY_RESERVE: 0,
    LINKEDIN_WATCHLIST_REPOLL_HOURS: 4, LINKEDIN_DISCOVERY_LIMIT: 1,
    LINKEDIN_KEYWORD_DISCOVERY_LIMIT: 1, LINKEDIN_KEYWORD_MIN_REACTIONS: 0,
    LINKEDIN_KEYWORD_POSTED_LIMIT: "week", NOELLE_APIFY_MAX_CONCURRENCY: 3,
    NOELLE_APIFY_SHARD_STAGGER_MS: 0,
  }) }));
  vi.doMock("../lib/logger.js", () => ({ createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
  }) }));
  vi.doMock("../lib/db.js", () => ({ noelleDb: () => vi.fn(async () => []) }));
  vi.doMock("../lib/secrets.js", () => ({ APIFY_TOKEN_SECRET_ID: "fixture", createSecretsClient: () => ({}) }));
  vi.doMock("../lib/activation.js", () => ({
    listActiveOrPausedLinkedinInternInstances: vi.fn(),
    isWorkerEnabled: (_inst: unknown, kind: string) => lane === "watch" ? kind === "watchlist" : kind === "discovery",
  }));
  vi.doMock("../lib/goal.js", () => ({ effectiveDraftsCap: () => null, enforceGoal: async () => null }));
  vi.doMock("../lib/boot.js", () => ({ EX_TEMPFAIL: 75, runBootChecks: async () => ({ ok: true }) }));
  vi.doMock("../lib/worker-runs.js", () => ({ recordRun: async () => ({ finish }) }));
  vi.doMock("../lib/bus.js", () => ({ busForInstance: () => ({ emit: vi.fn(async () => {}) }) }));
  vi.doMock("../lib/watchlist-db.js", () => ({
    getWatchlistPeople: async () => people, getLinkedinKeywords: async () => ["one", "two", "three"],
  }));
  vi.doMock("../lib/leads-db.js", () => ({
    countExtractedToday: async () => args.already ?? 0, countLeadBacklogForInstance: async () => 0,
    countPendingApprovalsForInstance: async () => 0, upsertDiscoveredLead: upsertLead,
  }));
  vi.doMock("../lib/apify-resolver.js", () => ({ createApifyPoolResolver: () => resolvePool }));
  vi.doMock("@noelle/runtime/notifier", () => ({ createNotifier: () => ({}) }));
  vi.doMock("@noelle/runtime/pg-spend-recorder", () => ({ createPgSpendRecorder: () => ({ record: vi.fn(async () => {}) }) }));
  vi.doMock("./_runtime.js", () => ({
    installShutdown: () => () => false,
    runWorkerLoop: async ({ onTick }: { onTick: (inst: unknown) => Promise<void> }) => {
      for (let tick = 0; tick < (args.poolFailure ? 2 : 1); tick++) {
        try {
          await onTick({ id: "instance", org_id: "org", status: lane === "watch" ? "paused" : "active",
            ...(lane === "icp" ? { icp_config: { headlineKeywords: ["founder"], postQueries: ["one", "two", "three"] } } : {}) });
        } catch (err) {
          errors.push(err);
        }
      }
      done();
    },
  }));
  await import("./discovery.js");
  await completed;
  if (!args.poolFailure) expect(errors).toEqual([]);
  return { pool, resolvePool, upsertLead, finish, errors, unavailable, providerCallsAtFinish };
}

describe("funded LinkedIn discovery shards", () => {
  it("records an unavailable pool before provider work and recovers on the next tick", async () => {
    const result = await scenario({ cap: 1, poolFailure: true });
    expect(result.errors).toEqual([result.unavailable]);
    expect(result.finish.mock.calls[0]?.[0]).toEqual({ status: "error", errorMessage: result.unavailable.message });
    expect(result.finish.mock.calls[1]?.[0]).toEqual({ status: "ok", rowsProcessed: 0 });
    expect(result.resolvePool).toHaveBeenCalledTimes(2);
    expect(result.providerCallsAtFinish).toEqual([0, 3]);
    expect(result.pool.flatMap(p => p.client.profilePosts.mock.calls.map(([a]) => a.publicId)).sort())
      .toEqual(["a", "b", "c"]);
  });
  it.each([1, 3, 0])("keeps watched people on funded shards with daily cap %s", async cap => {
    const result = await scenario({ cap });
    expect(result.pool.flatMap(p => p.client.profilePosts.mock.calls.map(([a]) => a.publicId)).sort())
      .toEqual(["a", "b", "c"]);
    expect(result.finish).toHaveBeenCalledWith({ status: "ok", rowsProcessed: 0 });
  });
  it.each(["keyword", "icp"] as const)("keeps every %s query on a funded shard", async lane => {
    const result = await scenario({ cap: 1, lane });
    expect(result.pool.flatMap(p => p.client.searchPosts.mock.calls.map(([a]) => (a as { queries: string[] }).queries)).flat().sort())
      .toEqual(["one", "three", "two"]);
    expect(result.pool.reduce((n, p) => n + p.client.searchProfiles.mock.calls.length, 0)).toBe(lane === "icp" ? 1 : 0);
  });
  it("preserves the exhausted daily-cap gate before pool lookup", async () => {
    const result = await scenario({ cap: 1, already: 1 });
    expect(result.resolvePool).not.toHaveBeenCalled();
    expect(result.pool.every(p => p.client.profilePosts.mock.calls.length === 0)).toBe(true);
  });
  it("still stops after the one remaining slot is filled", async () => {
    const result = await scenario({ cap: 1, posts: true });
    expect(result.upsertLead).toHaveBeenCalledOnce();
    expect(result.pool.reduce((n, p) => n + p.client.profilePosts.mock.calls.length, 0)).toBe(1);
    expect(result.finish).toHaveBeenCalledWith({ status: "ok", rowsProcessed: 1 });
  });
});

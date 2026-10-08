import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../lib/logger.js";
import type { ApifyRunReceipt } from "@noelle/runtime/apify-run-receipts";
import { runDiscoveryTick } from "./discovery-tick.js";
import { runProfilerTick } from "./profiler-tick.js";
import { runAccountFeederTick } from "./account-feeder-tick.js";

vi.mock("../lib/apify-rotating.js", () => ({ AllApifyTokensExhaustedError: class extends Error {} }));

const person = { id: "person", fsdProfileId: "profile", publicId: "builder", name: "Builder",
  headline: "Founder", objective: null, addedAt: "2026-06-01T00:00:00Z" };
function setup(fails: boolean, actualUsd: number | null) {
  let pending: ApifyRunReceipt[] = [];
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const recorder = { record: vi.fn().mockResolvedValue(undefined) };
  const call = (actor: string) => async () => {
    pending = [{ runId: "paid", actor, actualUsd, status: "SUCCEEDED", terminal: true,
      credentialId: "actual-credential", resultCount: 0, resultCountComplete: true, fetchedResultCount: 0 }];
    if (fails) throw new Error("dataset failed");
    return [];
  };
  const source = { profilePosts: call("linkedin-profile-posts"), searchPosts: call("linkedin-post-search"),
    searchProfiles: call("linkedin-profile-search"), authoredComments: call("linkedin-profile-comments"),
    drainRunReceipts: () => { const rows = pending; pending = []; return rows; } };
  return { source, log, recorder, instance: { id: "instance", org_id: "org" } as never };
}

describe("LinkedIn worker per-attempt Apify metering", () => {
  it.each(["watch", "keyword", "profile_search"] as const)("meters failed and empty paid %s discovery runs, including real zero", async lane => {
    for (const fails of [false, true]) for (const actualUsd of [0, 0.37]) {
      const fixture = setup(fails, actualUsd);
      await runDiscoveryTick({ ...fixture, postsSource: fixture.source,
        watchlistPeople: lane === "watch" ? [person] : [], discoveryLimit: 5,
        dailyExtractCap: 80, alreadyExtractedToday: 0,
        upsertLead: vi.fn().mockResolvedValue({ id: "lead", inserted: true }),
        ...(lane === "keyword" ? { keywords: ["builders"], keywordConfig: { searchLimit: 5, minReactions: 0, postedLimit: "week" } } : {}),
        ...(lane === "profile_search" ? { icp: { headlineKeywords: ["founder"] } } : {}),
      });
      expect(fixture.recorder.record).toHaveBeenCalledOnce();
      expect(fixture.recorder.record.mock.calls[0]![0]).toMatchObject({ cents: Math.round(actualUsd * 100),
        credentialId: "actual-credential", costBasis: "provider_reported" });
    }
  });

  it("meters paid empty/failed profiler reads before its existing local backoff", async () => {
    for (const fails of [false, true]) {
      const fixture = setup(fails, 0.37);
      const markAttempted = vi.fn().mockResolvedValue(undefined);
      await runProfilerTick({ ...fixture, postsSource: fixture.source, people: [person],
        runner: { draft: vi.fn() } as never, upsertProfile: vi.fn(), markAttempted });
      expect(fixture.recorder.record).toHaveBeenCalledOnce();
      expect(markAttempted).toHaveBeenCalledOnce();
    }
  });

  it("meters both empty feeder lanes and a failed first lane without double counting", async () => {
    for (const fails of [false, true]) {
      const fixture = setup(fails, 0.37);
      await runAccountFeederTick({ ...fixture, apify: fixture.source,
        sources: [{ id: "source", handle: "builder", platform: "linkedin", displayName: null, note: null }],
        extractor: { call: vi.fn() } as never, upsertStylePosts: vi.fn().mockResolvedValue(0),
        getCorpus: vi.fn().mockResolvedValue([]), upsertUltraProfile: vi.fn(), markSourcePulled: vi.fn() });
      expect(fixture.recorder.record).toHaveBeenCalledTimes(fails ? 1 : 2);
      expect(fixture.recorder.record.mock.calls.map(([row]) => row.model)).toEqual(fails
        ? ["apify/linkedin-profile-posts"] : ["apify/linkedin-profile-posts", "apify/linkedin-profile-comments"]);
    }
  });

  it("warns instead of estimating normalized array length when usage and raw total are unknown", async () => {
    const fixture = setup(false, null);
    await runDiscoveryTick({ ...fixture, postsSource: { profilePosts: async () => [], drainLastRunUsd: () => null },
      watchlistPeople: [person], discoveryLimit: 5, dailyExtractCap: 80, alreadyExtractedToday: 0,
      upsertLead: vi.fn() });
    expect(fixture.recorder.record).not.toHaveBeenCalled();
    expect(fixture.log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("spend unknown"));
  });
});

import { beforeEach, expect, it, vi } from "vitest";
import type { VideoClip } from "@noelle/video-apify";
import type { HarvestRunSummary } from "@noelle/contracts";
import { BudgetExceededError } from "@noelle/runtime";
import type { HarvesterTickDeps } from "./harvester-tick.js";
const state = vi.hoisted(() => ({ upsert: vi.fn(async (_sql: unknown, _args: { clips: VideoClip[] }) => 1), stamp: vi.fn(),
  niches: false, summaries: [] as HarvestRunSummary[] }));
vi.mock("@noelle/runtime", async original => ({ ...await original<Record<string, unknown>>(),
  evaluateJevBoolean: async () => ({ kind: "unavailable", provider: "jev" }) }));
vi.mock("../lib/watchlist-db.js", () => ({ listEnabledSources: async () => [{ id: "source", platform: "instagram", handle: "example" }],
  listEnabledNiches: async () => state.niches ? [{ id: "niche", platform: "instagram", query: "builders" }] : [],
  markSourcePulled: state.stamp, markNichePulled: vi.fn() }));
vi.mock("../lib/video-clips-db.js", () => ({ upsertVideoClips: state.upsert, flagDeepTier: async () => {} }));
import { runHarvesterTick } from "./harvester-tick.js";
const clip = (followers: unknown): VideoClip => ({ id: "clip", platform: "instagram", authorHandle: "example", caption: "Clip",
  url: "https://example.test/clip", videoUrl: null, thumbUrl: null, views: 10, likes: 0, comments: 0, shares: 0, saves: 0,
  durationSec: null, musicId: null, musicName: null, authorFollowerCount: followers, postedAt: null, raw: {} } as VideoClip);
async function run(snapshot: unknown, followers: unknown, gradeJson?: HarvesterTickDeps["gradeJson"]) {
  return runHarvesterTick({ sql: (() => Promise.resolve([])) as never,
    instance: { id: "instance", org_id: "org", objective: "Building lessons", video_feeder_config: {} } as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, recorder: { record: vi.fn() },
    resolveApify: async () => ({ credentialId: null, client: { accountSnapshot: async () => ({ followerCount: snapshot }),
      creatorReels: async () => [clip(followers)], nicheCreatorReels: async () => [{ ...clip(followers), views: 1_000_000 }] } as never }),
    ...(gradeJson ? { gradeJson } : {}),
    run: { isCancelRequested: async () => false, updateSummary: async summary => { state.summaries.push(structuredClone(summary)); } },
  });
}
beforeEach(() => { vi.clearAllMocks(); state.niches = false; state.upsert.mockResolvedValue(1); state.summaries.length = 0; });
it("retains measured zero followers instead of using another clip's count", async () => {
  await run(0, 100);
  expect(state.stamp).toHaveBeenCalledWith(expect.anything(), "source", 0);
  expect(state.upsert.mock.calls[0]![1].clips[0]!.authorFollowerCount).toBe(0);
});
it.each([0, 1])("retains acknowledged creator count %i in a stopped grade run", async written => {
  state.niches = true; state.upsert.mockResolvedValue(written);
  const error = new BudgetExceededError({ layer: "instance", spent_cents: 0, cap_cents: 0, estimated_cents: 1 });
  await expect(run(100, null, vi.fn().mockRejectedValue(error))).rejects.toMatchObject({ cause: error, rowsProcessed: written });
  const summary = state.summaries.at(-1)!;
  expect(summary).toMatchObject({ phase: "error", totals: { pulled: 2, kept: written }, error: error.message });
  expect(summary.lanes[1]).toMatchObject({ pulled: 1, selected: 1, kept: 0, error: error.message });
  expect(state.upsert).toHaveBeenCalledOnce(); expect(state.summaries.some(s => s.phase === "done")).toBe(false);
});
it("preserves unknown followers when neither source measurement is valid", async () => {
  await run(-1, null);
  expect(state.stamp).toHaveBeenCalledWith(expect.anything(), "source", null);
});
it("reports selected candidates separately from acknowledged written rows", async () => {
  state.upsert.mockResolvedValue(0);
  expect(await run(100, null)).toBe(0);
  const summary = state.summaries.at(-1)!;
  expect(summary.totals.kept).toBe(0);
  expect(summary.lanes[0]).toMatchObject({ pulled: 1, selected: 1, kept: 0 });
});

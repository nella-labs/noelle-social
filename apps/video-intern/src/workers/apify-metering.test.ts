import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApifyVideoClient } from "@noelle/video-apify";
import { createRotatingApifyClient } from "../lib/apify-rotating.js";
import { runHarvesterTick } from "./harvester-tick.js";
import { runSelfTrackTick } from "./self-track-tick.js";

vi.mock("../lib/watchlist-db.js", () => ({
  listEnabledSources: vi.fn(async () => [{ id: "source", platform: "tiktok", handle: "creator" }]),
  listEnabledNiches: vi.fn(async () => [{ id: "niche", platform: "tiktok", query: "builders" }]),
  markSourcePulled: vi.fn(), markNichePulled: vi.fn(),
}));
vi.mock("../lib/video-clips-db.js", () => ({ upsertVideoClips: vi.fn(async () => 0), flagDeepTier: vi.fn(async () => 0) }));
vi.mock("../lib/self-tracking-db.js", () => ({
  listDueOwnSources: vi.fn(async () => [{ id: "source", platform: "tiktok", handle: "creator", orgId: "org", instanceId: "instance" }]),
  recordClipMetricsSnapshot: vi.fn(async () => 0),
}));

function fixture(actualUsd: number | undefined, fails: boolean) {
  let posts = 0;
  const client = createRotatingApifyClient({
    candidates: [{ credentialId: "actual-token", token: "fixture", wasExhausted: false }],
    buildClient: token => createApifyVideoClient({ token, fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ data: { id: String(++posts), status: "SUCCEEDED",
        defaultDatasetId: String(posts), ...(actualUsd === undefined ? {} : { usageTotalUsd: actualUsd }) } });
      return fails ? new Response("dataset failure", { status: 500 })
        : Response.json([], { headers: { "X-Apify-Pagination-Total": "0" } });
    }) as typeof fetch }),
  });
  return { client, posts: () => posts, recorder: { record: vi.fn().mockResolvedValue(undefined) },
    log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } };
}
async function run(worker: "harvester" | "self-track", value: ReturnType<typeof fixture>) {
  const common = { sql: (() => Promise.resolve([])) as never, log: value.log as never, recorder: value.recorder,
    resolveApify: async () => ({ client: value.client, credentialId: "stale-token" }) };
  if (worker === "harvester") return runHarvesterTick({ ...common,
    instance: { id: "instance", org_id: "org", video_feeder_config: {} } as never });
  return runSelfTrackTick({ ...common, dueBefore: new Date(), maxPosts: 3, windowDays: 7 });
}

beforeEach(() => vi.clearAllMocks());
describe("video per-attempt Apify metering", () => {
  it.each(["harvester", "self-track"] as const)("records paid empty and failed %s runs, including real zero", async worker => {
    for (const fails of [false, true]) for (const actualUsd of [0, 0.37]) {
      const value = fixture(actualUsd, fails);
      await run(worker, value);
      const attempts = worker === "harvester" ? 3 : 2;
      expect(value.posts()).toBe(attempts);
      expect(value.recorder.record).toHaveBeenCalledTimes(attempts);
      expect(value.recorder.record.mock.calls.map(([row]) => [row.cents, row.credentialId, row.costBasis]))
        .toEqual(Array.from({ length: attempts }, () => [Math.round(actualUsd * 100), "actual-token", "provider_reported"]));
    }
  });
  it.each(["harvester", "self-track"] as const)("does not invent one billed snapshot item after unknown %s usage", async worker => {
    const value = fixture(undefined, true);
    await run(worker, value);
    expect(value.recorder.record).not.toHaveBeenCalled();
    expect(value.log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("spend unknown"));
  });
});

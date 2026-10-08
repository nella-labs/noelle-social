import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openProfilingFixture, profilingInstance, profilingOrg } from "../lib/profiling-fixture.js";
import { getXWatchlistAuthorEngagement } from "../lib/x-ideation-gather-db.js";
import { runAnalystTick, type RunAnalystTickArgs } from "./analyst-tick.js";
import { runIdeationTick, type RunIdeationTickArgs } from "./ideation-tick.js";

const url = process.env.X_PROFILING_TEST_DATABASE_URL;
describe.skipIf(!url)("profiling feedback actual worker consumers", () => {
  let fixture: Awaited<ReturnType<typeof openProfilingFixture>>;
  beforeAll(async () => {
    fixture = await openProfilingFixture(url!);
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
  const instance = { id: profilingInstance, org_id: profilingOrg };
  const gatherArgs = {
    agentInstanceId: profilingInstance,
    windowDays: 30,
    limitAuthors: 20,
    samplePosts: 3,
    minPosts: 1,
  };

  it("dispatches only the measured author and persists exact sample provenance", async () => {
    await fixture.watch("measured");
    await fixture.watch("unknown");
    const lead = await fixture.lead("measured", { likes: 0, replies: "0", reposts: 0 });
    await fixture.lead("unknown", { likes: {}, replies: "bad", reposts: null });
    const draft = vi.fn().mockResolvedValue({ text: "{}", model: "fixture", engine: "fixture" });
    expect(
      await runAnalystTick({
        sql: fixture.sql,
        log,
        instance,
        runner: { draft } as RunAnalystTickArgs["runner"],
        windowDays: 30,
        limitAuthors: 20,
        maxPerTick: 5,
        samplePosts: 3,
        minPosts: 1,
        staleDays: 14,
      }),
    ).toEqual({ ranked: 1, refreshed: 1, skippedFresh: 0 });
    expect(draft).toHaveBeenCalledTimes(1);
    expect(draft.mock.calls[0]?.[0]).toMatchObject({
      orgId: profilingOrg,
      instanceId: profilingInstance,
      worker: "profiler",
      bucket: "analyst",
    });
    expect(draft.mock.calls[0]?.[0].prompt).toContain("0 likes, 0 replies, 0 reposts");
    expect(
      await fixture.sql`select author_handle,sample_post_ids from noelle.watchlist_playbooks`,
    ).toMatchObject([{ author_handle: "measured", sample_post_ids: [lead] }]);
  });

  it("unknown-only counts cause no analyst model call but still ground a topic idea", async () => {
    await fixture.watch("builder");
    await fixture.lead("builder", {
      text: "A delayed train can erase the savings on a cheaper ticket.",
      likes: "bad",
    });
    const analyst = vi.fn();
    expect(
      await runAnalystTick({
        sql: fixture.sql,
        log,
        instance,
        runner: { draft: analyst } as RunAnalystTickArgs["runner"],
        windowDays: 30,
        limitAuthors: 20,
        maxPerTick: 5,
        samplePosts: 3,
        minPosts: 1,
        staleDays: 14,
      }),
    ).toEqual({ ranked: 0, refreshed: 0, skippedFresh: 0 });
    expect(analyst).not.toHaveBeenCalled();
    const draft = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        ideas: [
          {
            hook: "A delayed train can erase the savings on a cheaper ticket.",
            thesis: "Compare the fare with the extra travel time before booking.",
            pillar: "travel",
            angle: "observation",
            inspiration_tags: ["W1"],
          },
        ],
      }),
      model: "fixture",
      engine: "fixture",
    });
    const sink = vi.fn<RunIdeationTickArgs["sink"]>().mockResolvedValue({ idea_ids: ["idea"] });
    expect(
      await runIdeationTick({
        log,
        instance,
        runner: { draft },
        sink,
        idFactory: () => "idea",
        defaultCount: 1,
        request: {
          id: "request",
          orgId: profilingOrg,
          agentInstanceId: profilingInstance,
          mode: "single",
          count: 1,
          topics: [],
          weekStart: null,
          batchId: null,
          ideaId: null,
          targetPlatforms: null,
        },
        gather: async () => ({
          topAuthors: await getXWatchlistAuthorEngagement(fixture.sql, gatherArgs),
          keywordPosts: [],
          voiceAnchors: [],
          pillars: ["travel"],
        }),
      }),
    ).toBe(1);
    expect(draft.mock.calls[0]?.[0].prompt).toContain(
      "unknown likes, unknown reposts, unknown replies",
    );
    expect(sink.mock.calls[0]?.[0][0]?.inspirationRefs[0]?.note).toBe(
      "unknown likes, unknown reposts, unknown replies",
    );
  });
  it("persists equal ranks for tied measured authors", async () => {
    await fixture.watch("alpha");
    await fixture.watch("beta");
    await fixture.lead("alpha", { likes: 0, replies: 0, reposts: 0 });
    await fixture.lead("beta", { likes: 0, replies: 0, reposts: 0 });
    const draft = vi.fn().mockResolvedValue({ text: "{}", model: "fixture", engine: "fixture" });
    expect(
      await runAnalystTick({
        sql: fixture.sql,
        log,
        instance,
        runner: { draft } as RunAnalystTickArgs["runner"],
        windowDays: 30,
        limitAuthors: 20,
        maxPerTick: 5,
        samplePosts: 3,
        minPosts: 1,
        staleDays: 14,
      }),
    ).toEqual({ ranked: 2, refreshed: 2, skippedFresh: 0 });
    const rows = await fixture.sql`select author_handle,engagement_percentile::text as percentile
      from noelle.watchlist_playbooks order by author_handle`;
    expect(rows).toEqual([
      { author_handle: "alpha", percentile: "0.5" },
      { author_handle: "beta", percentile: "0.5" },
    ]);
  });
  it.each(["parent", "source"])(
    "does not acknowledge a %s rebind during analyst generation",
    async (kind) => {
      await fixture.watch("builder");
      const lead = await fixture.lead("builder", { likes: 0, replies: 0, reposts: 0 });
      const draft = vi.fn(async () => {
        if (kind === "parent") {
          await fixture.sql`update noelle.agent_instances set role='other' where id=${profilingInstance}`;
        } else {
          await fixture.sql`update noelle.leads set author_handle='another' where external_id=${lead}`;
        }
        return { text: "{}", model: "fixture", engine: "fixture" };
      });
      expect(
        await runAnalystTick({
          sql: fixture.sql,
          log,
          instance,
          runner: { draft } as RunAnalystTickArgs["runner"],
          windowDays: 30,
          limitAuthors: 20,
          maxPerTick: 5,
          samplePosts: 3,
          minPosts: 1,
          staleDays: 14,
        }),
      ).toEqual({ ranked: 1, refreshed: 0, skippedFresh: 0 });
      expect(draft).toHaveBeenCalledOnce();
      expect(await fixture.sql`select id from noelle.watchlist_playbooks`).toEqual([]);
    },
  );
});

import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoTeardownSchema } from "@noelle/contracts";
import { retryVideoTeardown } from "@noelle/runtime/video-teardown-claims-db";
import { runTeardownTick } from "./teardown-tick.js";
import { createLogger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import { ModelNotDispatchedError } from "@noelle/runtime";
import type { TeardownAnalyzeInput } from "../lib/teardown-analyze.js";

const extraction = vi.hoisted(() => vi.fn());
vi.mock("@noelle/video-extract", () => ({ extractVideo: extraction }));
const url = process.env.NOELLE_VIDEO_TEARDOWN_CLAIMS_TEST_DATABASE_URL;
const output = VideoTeardownSchema.parse({ hook: { text: "Saved hook", type: "question" },
  pacing: { cutsPerSec: 0.1, avgBeatSec: 1, wordsPerSec: 1 }, cta: { present: false }, sound: {}, whyItWorked: "Observed structure" });

describe.skipIf(!url)("Durable Video teardown dispatch (native PostgreSQL)", () => {
  let sql: Sql;
  let instance: ActiveInstance;
  const log = createLogger({ kind: "teardown-claims-native", workerId: "native" }); log.level = "silent";
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_video_teardown_claims_test")
      throw new Error("dedicated Video teardown claims test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0065_video_intern_watchlist.sql", "0066_video_intern_corpus.sql",
      "0067_video_intern_studio.sql", "0073_video_self_tracking.sql", "0080_video_recording_briefs.sql",
      "0120_video_metrics_nullable.sql", "0122_video_teardown_attempts.sql", "0123_video_recording_brief_attempts.sql",
      "0124_video_teardown_preparation_failed.sql"])
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    const org = String((await sql`insert into noelle.organizations(slug,name) values ('dispatch_owned','Owned') returning id`)[0]!.id);
    const id = String((await sql`insert into noelle.agent_instances(org_id,role) values (${org},'video_intern') returning id`)[0]!.id);
    instance = { id, org_id: org, status: "active", objective: null, video_feeder_config: null, budget_cap_cents: null };
    await sql`insert into noelle.video_clips(org_id,agent_instance_id,external_id,author_handle,url)
      values (${org},${id},'saved','example','https://example.test/reel/saved')`;
    extraction.mockReset().mockResolvedValue({ transcript: "", keyframePaths: [], cutTimestamps: [], durationS: 1 });
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  const tick = (analyze: () => Promise<typeof output | null>, dailyCap = 10) => {
    const analyzer = { analyze: async (input: TeardownAnalyzeInput) => {
      if (await input.operation!.beforeDispatch(performance.now() + 1000) !== "dispatch") throw new ModelNotDispatchedError();
      return analyze();
    } };
    return runTeardownTick({ sql, log, instance, bulkAnalyzer: analyzer, deepAnalyzer: analyzer, batchLimit: 4, dailyCap });
  };

  it("preserves one successful sequential analysis and its acknowledged count", async () => {
    let calls = 0; const analyze = async () => { calls++; return output; };
    expect(await tick(analyze)).toBe(1); expect(await tick(analyze)).toBe(0); expect(calls).toBe(1);
  });
  it("admits one analysis for overlapping actual ticks while the first response is unresolved", async () => {
    let enter!: () => void; let enterSecond!: () => void; let release!: () => void; let calls = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const secondEntered = new Promise<void>(resolve => { enterSecond = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const analyze = async () => { if (++calls === 1) enter(); else enterSecond(); await released; return output; };
    const first = tick(analyze); await entered;
    const second = tick(analyze).catch(err => {
      expect(err).toMatchObject({ reason: "generation_in_progress", rowsProcessed: 0 }); return 0;
    });
    try { await Promise.race([secondEntered, second]); expect(calls).toBe(1); }
    finally { release(); await Promise.all([first, second]); }
    expect(await sql`select id from noelle.video_teardowns`).toHaveLength(1);
  });
  it("retains an opaque paid outcome and never automatically repeats the analyzer", async () => {
    let calls = 0; const analyze = async () => { calls++; return null; };
    await expect(tick(analyze)).rejects.toMatchObject({ reason: "generation_unknown", rowsProcessed: 0 });
    await expect(tick(analyze)).rejects.toMatchObject({ reason: "generation_unknown", rowsProcessed: 0 });
    expect(calls).toBe(1); expect(await sql`select id from noelle.video_teardowns`).toHaveLength(0);
    expect((await sql`select status from noelle.video_teardown_attempts`)[0]?.status).toBe("unknown");
  });
  it("rejects a superseded in-flight response and runs only the explicitly queued new identity", async () => {
    let enter!: () => void; let release!: () => void; let calls = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = tick(async () => { calls++; enter(); await held; return output; }).catch(err => err);
    await entered;
    const [original] = await sql<{ id: string; clip_id: string }[]>`select id,clip_id from noelle.video_teardown_attempts`;
    let queued: string | null = null; let outcome: unknown;
    try {
      queued = await retryVideoTeardown(sql, { orgId: instance.org_id, instanceId: instance.id,
        clipId: original!.clip_id, expectedClaimUUID: original!.id, operatorId: "operator" });
      expect(queued).not.toBeNull(); expect(calls).toBe(1);
    } finally { release(); outcome = await pending; }
    expect(outcome).toMatchObject({ reason: "source_changed", rowsProcessed: 0 });
    expect(await sql`select id from noelle.video_teardowns`).toHaveLength(0);
    expect(await tick(async () => { calls++; return output; })).toBe(1);
    expect(calls).toBe(2);
    expect(await sql`select id,status from noelle.video_teardown_attempts order by created_at,id`).toEqual([
      { id: original!.id, status: "superseded" }, { id: queued!, status: "complete" }]);
    expect(await sql`select id from noelle.video_teardowns`).toHaveLength(1);
  });
});

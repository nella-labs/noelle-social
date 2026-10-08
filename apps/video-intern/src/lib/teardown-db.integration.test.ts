import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoTeardownSchema } from "@noelle/contracts";
import { createLogger } from "./logger.js";
import { countTeardownsToday, claimClipsForTeardown, upsertTeardown } from "./teardown-db.js";
import { runTeardownTick } from "../workers/teardown-tick.js";

const extraction = vi.hoisted(() => vi.fn());
vi.mock("@noelle/video-extract", () => ({ extractVideo: extraction }));
const url = process.env.NOELLE_VIDEO_TEARDOWN_TEST_DATABASE_URL;
const output = VideoTeardownSchema.parse({ hook: { text: "Saved hook", type: "question" },
  pacing: { cutsPerSec: 0.1, avgBeatSec: 1, wordsPerSec: 1 }, cta: { present: false }, sound: {}, whyItWorked: "Observed structure" });

describe.skipIf(!url)("Coherent Video teardown storage (native PostgreSQL)", () => {
  let sql: Sql; let org: string; let other: string; let instance: string; let otherInstance: string;
  const log = createLogger({ kind: "teardown-native", workerId: "native" }); log.level = "silent";
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_video_teardown_test")
      throw new Error("dedicated Video teardown test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0065_video_intern_watchlist.sql", "0066_video_intern_corpus.sql",
      "0067_video_intern_studio.sql", "0073_video_self_tracking.sql", "0080_video_recording_briefs.sql",
      "0120_video_metrics_nullable.sql", "0122_video_teardown_attempts.sql"])
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    org = String((await sql`insert into noelle.organizations(slug,name) values ('td_owned','Owned') returning id`)[0]!.id);
    other = String((await sql`insert into noelle.organizations(slug,name) values ('td_other','Other') returning id`)[0]!.id);
    instance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${org},'video_intern') returning id`)[0]!.id);
    otherInstance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${other},'video_intern') returning id`)[0]!.id);
    extraction.mockReset().mockResolvedValue({ transcript: "", keyframePaths: [], cutTimestamps: [], durationS: 1.5 });
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  async function clip(foreignOrg = false, foreignParent = false) {
    return String((await sql`insert into noelle.video_clips(org_id,agent_instance_id,external_id,author_handle,url)
      values (${foreignOrg ? other : org},${foreignParent ? otherInstance : instance},'saved','example','https://example.test/reel/saved') returning id`)[0]!.id);
  }
  const write = (clipId: string, platform = "instagram", owner = org) => upsertTeardown(sql, {
    orgId: owner, instanceId: instance, clipId, platform, teardown: output, transcript: null, tier: "bulk", model: "saved-model",
  });
  const candidates = () => claimClipsForTeardown(sql, { instanceId: instance, orgId: org, limit: 4, dailyCap: 10 });
  const stored = () => sql`select org_id,agent_instance_id,clip_id,platform,teardown,model from noelle.video_teardowns`;
  const tick = (analyze: () => Promise<typeof output | null>) => runTeardownTick({ sql, log,
    instance: { id: instance, org_id: org, status: "active", objective: null, video_feeder_config: null, budget_cap_cents: null },
    bulkAnalyzer: { analyze }, deepAnalyzer: { analyze }, batchLimit: 4, dailyCap: 10 });

  it("preserves a coherent write and reports an acknowledged receipt", async () => {
    const id = await clip(); const acknowledged = await write(id);
    expect((await stored())[0]).toMatchObject({ org_id: org, agent_instance_id: instance, clip_id: id, platform: "instagram", teardown: output });
    expect(acknowledged).toBe(true);
  });
  it("rejects an independently foreign clip reference before storing output", async () => {
    await write(await clip(true, true)); expect(await stored()).toHaveLength(0);
  });
  it.each(["role", "org", "platform"])("rejects current %s mismatch on write", async field => {
    const id = await clip();
    if (field === "role") await sql`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`;
    await write(id, field === "platform" ? "tiktok" : "instagram", field === "org" ? other : org);
    expect(await stored()).toHaveLength(0);
  });
  it("preserves a foreign soft-reference conflict without overwriting its output", async () => {
    const id = await clip();
    await sql`insert into noelle.video_teardowns(org_id,agent_instance_id,clip_id,platform,teardown,model)
      values (${other},${otherInstance},${id},'instagram',${sql.json(output as never)},'foreign-original')`;
    await write(id); expect((await stored())[0]?.model).toBe("foreign-original");
    expect(await candidates()).toHaveLength(0);
  });
  it("excludes a foreign source before extraction or paid analysis", async () => {
    await clip(true); let calls = 0;
    expect(await tick(async () => { calls++; return output; })).toBe(0);
    expect(extraction).not.toHaveBeenCalled(); expect(calls).toBe(0);
  });
  it("excludes a non-Video current parent before extraction or paid analysis", async () => {
    await clip(); await sql`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`;
    let calls = 0; expect(await tick(async () => { calls++; return output; })).toBe(0);
    expect(extraction).not.toHaveBeenCalled(); expect(calls).toBe(0);
  });
  it("counts only coherent teardowns for the current org and parent", async () => {
    const id = await clip();
    await sql`insert into noelle.video_teardowns(org_id,agent_instance_id,clip_id,platform,teardown,generated_at)
      values (${other},${instance},${id},'instagram',${sql.json(output as never)},now())`;
    expect(await countTeardownsToday(sql, instance, org)).toBe(0);
    await sql`delete from noelle.video_teardowns where clip_id=${id}`;
    expect(await write(id)).toBe(true); expect(await countTeardownsToday(sql, instance, org)).toBe(1);
    await sql`update noelle.video_clips set platform='tiktok' where id=${id}`;
    expect(await countTeardownsToday(sql, instance, org)).toBe(0);
  });
  it("keeps unknown source metrics unknown through actual analysis and saves once", async () => {
    await clip(); let metrics: unknown;
    const analyze = async (input: { metrics: unknown }) => { metrics = input.metrics; return output; };
    expect(await runTeardownTick({ sql, log,
      instance: { id: instance, org_id: org, status: "active", objective: null, video_feeder_config: null, budget_cap_cents: null },
      bulkAnalyzer: { analyze }, deepAnalyzer: { analyze }, batchLimit: 4, dailyCap: 10 })).toBe(1);
    expect(metrics).toMatchObject({ views: null, likes: null, comments: null, shares: null, durationS: 1.5 });
    expect(await candidates()).toHaveLength(0); expect(await stored()).toHaveLength(1);
  });
  it("does not count a result after the clip platform changes during analysis", async () => {
    const id = await clip();
    await expect(tick(async () => { await sql`update noelle.video_clips set platform='tiktok' where id=${id}`; return output; }))
      .rejects.toMatchObject({ reason: "source_changed", rowsProcessed: 0 });
    expect(await stored()).toHaveLength(0);
  });
  it("preserves native UUID case equivalence on a coherent refresh", async () => {
    const id = await clip(); expect(await write(id)).toBe(true);
    expect(await upsertTeardown(sql, { orgId: org.toUpperCase(), instanceId: instance.toUpperCase(),
      clipId: id.toUpperCase(), platform: "instagram", teardown: output, transcript: null, tier: "bulk", model: "refreshed" })).toBe(true);
    expect((await stored())[0]?.model).toBe("refreshed");
  });
  it("revalidates a changed parent after its lock before paid analysis", async () => {
    await clip(); let release!: () => void; let enter!: () => void;
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { enter = resolve; });
    const parent = sql.begin(async tx => {
      await tx`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`;
      enter(); await unlocked;
    });
    await locked; let settled = false; let calls = 0;
    const running = tick(async () => { calls++; return output; }).then(n => { settled = true; return n; });
    try { await new Promise(resolve => setTimeout(resolve, 40)); expect(settled).toBe(false); }
    finally { release(); await parent; }
    expect(await running).toBe(0); expect(calls).toBe(0); expect(extraction).not.toHaveBeenCalled();
  });
  it("revalidates the clip tuple after a source row lock", async () => {
    const id = await clip(); let release!: () => void; let enter!: () => void;
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { enter = resolve; });
    const source = sql.begin(async tx => {
      await tx`update noelle.video_clips set platform='tiktok' where id=${id}`;
      enter(); await unlocked;
    });
    await locked; let settled = false;
    const writing = write(id).then(n => { settled = true; return n; });
    try { await new Promise(resolve => setTimeout(resolve, 40)); expect(settled).toBe(false); }
    finally { release(); await source; }
    expect(await writing).toBe(false); expect(await stored()).toHaveLength(0);
  });
  it("a held parent times out without a late teardown after lock release", async () => {
    const id = await clip(); let release!: () => void; let enter!: () => void;
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { enter = resolve; });
    const parent = sql.begin(async tx => {
      await tx`select id from noelle.agent_instances where id=${instance} for update`; enter(); await unlocked;
    });
    await locked;
    try { await expect(write(id)).rejects.toMatchObject({ category: "deadline" }); }
    finally { release(); await parent; }
    expect(await stored()).toHaveLength(0);
  }, 10000);
});

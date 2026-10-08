import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VideoTeardownSchema } from "@noelle/contracts";
import { createLogger } from "../lib/logger.js";
import { runDistillerTick } from "./distiller-tick.js";

const url = process.env.NOELLE_VIDEO_SCOPE_TEST_DATABASE_URL;
describe.skipIf(!url)("Video distillation identities (native PostgreSQL)", () => {
  let sql: Sql;
  let org: string;
  let instance: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_video_scope_test") throw new Error("dedicated Video scope test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0065_video_intern_watchlist.sql", "0066_video_intern_corpus.sql", "0067_video_intern_studio.sql", "0073_video_self_tracking.sql", "0120_video_metrics_nullable.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    org = String((await sql`insert into noelle.organizations(slug,name) values ('video_distill','Video distill') returning id`)[0]!.id);
    instance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${org},'video_intern') returning id`)[0]!.id);
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  const log = createLogger({ kind: "distiller-test", workerId: "native" });
  log.level = "silent";
  const tick = () => runDistillerTick({ sql, instance: { id: instance, org_id: org, objective: null,
    status: "active", video_feeder_config: null, budget_cap_cents: null }, log, embedLimit: 0 });
  async function own(handle: string, platform = "instagram", enabled = true) {
    await sql`insert into noelle.video_watchlist_sources(org_id,agent_instance_id,platform,handle,is_own,enabled)
      values (${org},${instance},${platform},${handle},true,${enabled})`;
  }
  async function analyzed(handle: string, platform = "instagram", kind = "account", views = 10) {
    const id = String((await sql`insert into noelle.video_clips(org_id,agent_instance_id,platform,external_id,author_handle,source_kind,views)
      values (${org},${instance},${platform},${crypto.randomUUID()},${handle},${kind},${views}) returning id`)[0]!.id);
    const teardown = VideoTeardownSchema.parse({ hook: { text: "Saved hook", type: "question" },
      pacing: { cutsPerSec: 0.1, avgBeatSec: 1, wordsPerSec: 1 }, cta: { present: false }, sound: {}, whyItWorked: "Observed structure" });
    await sql`insert into noelle.video_teardowns(org_id,agent_instance_id,clip_id,platform,teardown)
      values (${org},${instance},${id},${platform},${sql.json(teardown)})`;
    return id;
  }
  it("actual worker creates a fresh own-only guide", async () => {
    await own("primary"); await analyzed("primary");
    expect((await tick()).profiles).toBe(1);
    expect((await sql`select scope,subject,clips_analyzed from noelle.video_ultra_profiles`)[0])
      .toEqual({ scope: "account", subject: "me", clips_analyzed: 1 });
  });
  it("preserves watched creator distillation", async () => {
    await analyzed("watched", "instagram", "creator");
    expect((await tick()).profiles).toBe(1);
    expect((await sql`select scope,subject from noelle.video_ultra_profiles`)[0]).toEqual({ scope: "creator", subject: "watched" });
  });
  it("partitions equal creator names by platform", async () => {
    await analyzed("same", "instagram", "creator", 10); await analyzed("same", "tiktok", "creator", 100);
    await tick();
    expect(await sql`select platform,avg_views::text,clips_analyzed from noelle.video_ultra_profiles order by platform`)
      .toEqual([{ platform: "instagram", avg_views: "10", clips_analyzed: 1 }, { platform: "tiktok", avg_views: "100", clips_analyzed: 1 }]);
  });
  it("does not infer cross-platform ownership", async () => {
    await own("same"); await analyzed("same", "tiktok", "creator");
    await tick();
    expect((await sql`select scope,subject from noelle.video_ultra_profiles`)[0]).toEqual({ scope: "creator", subject: "same" });
  });
  it("aggregates own handles once per platform and retains disabled own declarations", async () => {
    await own("first"); await own("Second", "instagram", false);
    await analyzed("first", "instagram", "account", 10); await analyzed("second", "instagram", "creator", 30);
    expect((await tick()).profiles).toBe(1);
    expect((await sql`select platform,scope,subject,avg_views::text,clips_analyzed from noelle.video_ultra_profiles`)[0])
      .toEqual({ platform: "instagram", scope: "account", subject: "me", avg_views: "20", clips_analyzed: 2 });
  });
  it("skips independent native foreign teardown ownership", async () => {
    const clipId = await analyzed("watched", "instagram", "creator");
    const other = String((await sql`insert into noelle.organizations(slug,name) values ('other_distill','Other') returning id`)[0]!.id);
    await sql`update noelle.video_teardowns set org_id=${other} where clip_id=${clipId}`;
    expect((await tick()).profiles).toBe(0);
  });
});

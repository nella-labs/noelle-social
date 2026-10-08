import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadVideoAccountTracking } from "./videoAccountDb.js";

const url = process.env.NOELLE_VIDEO_SCOPE_TEST_DATABASE_URL;
describe.skipIf(!url)("selected Video account (native PostgreSQL)", () => {
  let sql: Sql;
  let org: string;
  let other: string;
  let instance: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_video_scope_test") throw new Error("dedicated Video scope test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0065_video_intern_watchlist.sql", "0066_video_intern_corpus.sql", "0067_video_intern_studio.sql", "0073_video_self_tracking.sql", "0120_video_metrics_nullable.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    org = String((await sql`insert into noelle.organizations(slug,name) values ('video_scope','Video scope') returning id`)[0]!.id);
    other = String((await sql`insert into noelle.organizations(slug,name) values ('video_other','Other') returning id`)[0]!.id);
    instance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${org},'video_intern') returning id`)[0]!.id);
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  async function source(handle: string, platform = "instagram", enabled = true, sourceOrg = org, created = "2026-06-01T00:00:00Z") {
    return String((await sql`insert into noelle.video_watchlist_sources(org_id,agent_instance_id,platform,handle,is_own,enabled,created_at)
      values (${sourceOrg},${instance},${platform},${handle},true,${enabled},${created}) returning id`)[0]!.id);
  }
  async function clip(handle: string, platform = "instagram", clipOrg = org) {
    return String((await sql`insert into noelle.video_clips(org_id,agent_instance_id,platform,external_id,author_handle,source_kind)
      values (${clipOrg},${instance},${platform},${crypto.randomUUID()},${handle},'account') returning id`)[0]!.id);
  }
  async function metric(id: string, followers: number | null, captured: string, metricOrg = org) {
    await sql`insert into noelle.video_clip_metrics(org_id,agent_instance_id,clip_id,author_follower_count,captured_at)
      values (${metricOrg},${instance},${id},${followers},${captured})`;
  }
  it("selects one earliest enabled current-parent source with deterministic id ties", async () => {
    const ids = [await source("first"), await source("second")].sort();
    await source("disabled", "instagram", false, org, "2026-05-01T00:00:00Z");
    await source("foreign", "instagram", true, other, "2026-04-01T00:00:00Z");
    expect((await loadVideoAccountTracking(sql, instance)).account?.id).toBe(ids[0]);
  });
  it("keeps exact normalized handle and platform follower history", async () => {
    await source("Primary"); await source("primary", "tiktok", true, org, "2026-06-02T00:00:00Z");
    const own = await clip("primary"); const otherPlatform = await clip("primary", "tiktok");
    await metric(own, 100, "2026-06-03T08:00:00Z"); await metric(otherPlatform, 1000, "2026-06-03T09:00:00Z");
    await metric(own, 110, "2026-06-04T08:00:00Z");
    expect(await loadVideoAccountTracking(sql, instance)).toMatchObject({ account: { handle: "primary", platform: "instagram" },
      followerCount: 110, followerDelta: 10, followerSeries: [{ followerCount: 100 }, { followerCount: 110 }] });
  });
  it("returns unknown without an enabled own source", async () => {
    await source("disabled", "instagram", false); await metric(await clip("disabled"), 50, "2026-06-03T08:00:00Z");
    expect(await loadVideoAccountTracking(sql, instance)).toMatchObject({ account: null, followerCount: null, followerDelta: null, followerSeries: [] });
  });
  it("preserves zero but requires two distinct captures for delta", async () => {
    await source("primary"); const a = await clip("primary"); const b = await clip("primary");
    await metric(a, 0, "2026-06-03T08:00:00Z"); await metric(b, 0, "2026-06-03T08:00:00Z");
    expect(await loadVideoAccountTracking(sql, instance)).toMatchObject({ followerCount: 0, followerDelta: null });
    await metric(a, 0, "2026-06-04T08:00:00Z");
    expect(await loadVideoAccountTracking(sql, instance)).toMatchObject({ followerCount: 0, followerDelta: 0 });
  });
  it("excludes foreign soft references and invalid historical counts", async () => {
    await source("primary"); const own = await clip("primary");
    await metric(own, 10, "2026-06-03T08:00:00Z");
    await metric(own, 999, "2026-06-04T08:00:00Z", other);
    await metric(await clip("primary", "instagram", other), 9999, "2026-06-05T08:00:00Z");
    await metric(own, -1, "2026-06-06T08:00:00Z");
    expect(await loadVideoAccountTracking(sql, instance)).toMatchObject({ followerCount: 10, followerDelta: null });
    await sql`update noelle.agent_instances set org_id=${other} where id=${instance}`;
    expect((await loadVideoAccountTracking(sql, instance)).account).toBeNull();
  });
  it("caps emitted hourly points while keeping complete-window delta", async () => {
    await source("primary"); const id = await clip("primary");
    await sql`insert into noelle.video_clip_metrics(org_id,agent_instance_id,clip_id,author_follower_count,captured_at)
      select ${org}::uuid,${instance}::uuid,${id}::uuid,n,'2026-01-01T00:00:00Z'::timestamptz+n*interval '1 hour' from generate_series(0,749) n`;
    const tracking = await loadVideoAccountTracking(sql, instance);
    expect(tracking.followerSeries).toHaveLength(720);
    expect(tracking.followerSeries[0]?.followerCount).toBe(30);
    expect(tracking.followerCount).toBe(749); expect(tracking.followerDelta).toBe(749);
  });
  it("bounds a native reader waiting behind a table lock and disposes its blocked query", async () => {
    await source("primary");
    let ready!: () => void;
    let release!: () => void;
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const blocker = sql.begin(async tx => {
      await tx`lock table noelle.video_watchlist_sources in access exclusive mode`;
      ready(); await unlocked;
    });
    await locked;
    const started = performance.now();
    try {
      await expect(loadVideoAccountTracking(sql, instance)).rejects.toMatchObject({ category: "deadline" });
      expect(performance.now() - started).toBeLessThan(7000);
    } finally { release(); await blocker; }
    expect((await sql`select count(*)::int as n from pg_stat_activity
      where datname=current_database() and wait_event_type='Lock'`)[0]!.n).toBe(0);
    expect((await loadVideoAccountTracking(sql, instance)).account?.handle).toBe("primary");
  }, 10000);
});

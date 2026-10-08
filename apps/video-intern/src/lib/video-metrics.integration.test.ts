import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { VideoClip } from "@noelle/video-apify";
import { upsertVideoClips, flagDeepTier } from "./video-clips-db.js";
import { recordClipMetricsSnapshot, summarizeSelfMetrics } from "./self-tracking-db.js";

const url = process.env.NOELLE_VIDEO_METRICS_TEST_DATABASE_URL;
const migration = new URL("../../../../infra/cloudsql/schema/0120_video_metrics_nullable.sql", import.meta.url);
describe.skipIf(!url)("Video measurement storage (native PostgreSQL)", () => {
  let sql: Sql;
  let orgId: string;
  let otherOrgId: string;
  let instanceId: string;
  let historicalZerosPreserved = false;
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    if (!String((await sql`select current_database() as name`)[0]?.name).includes("video_metrics_test")) throw new Error("dedicated Video metrics test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0065_video_intern_watchlist.sql", "0066_video_intern_corpus.sql", "0067_video_intern_studio.sql", "0073_video_self_tracking.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
    const [legacyOrg] = await sql`insert into noelle.organizations(slug,name) values ('video_legacy','Video legacy') returning id`;
    const [legacyInstance] = await sql`insert into noelle.agent_instances(org_id,role) values (${legacyOrg!.id},'video_intern') returning id`;
    const [legacyClip] = await sql`insert into noelle.video_clips(org_id,agent_instance_id,external_id,author_handle)
      values (${legacyOrg!.id},${legacyInstance!.id},'legacy','example') returning id`;
    await sql`insert into noelle.video_clip_metrics(org_id,agent_instance_id,clip_id)
      values (${legacyOrg!.id},${legacyInstance!.id},${legacyClip!.id})`;
    if (existsSync(migration)) {
      const body = await readFile(migration, "utf8");
      await sql.unsafe(body);
      await sql.unsafe(body);
    }
    historicalZerosPreserved = (await sql`select views::text,likes::text from noelle.video_clips union all
      select views::text,likes::text from noelle.video_clip_metrics`).every(row => row.views === "0" && row.likes === "0");
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    orgId = String((await sql`insert into noelle.organizations(slug,name) values ('video_main','Video main') returning id`)[0]!.id);
    otherOrgId = String((await sql`insert into noelle.organizations(slug,name) values ('video_other','Video other') returning id`)[0]!.id);
    instanceId = String((await sql`insert into noelle.agent_instances(org_id,role) values (${orgId},'video_intern') returning id`)[0]!.id);
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  const clip = (over: Record<string, unknown> = {}): VideoClip => ({
    id: "clip", platform: "instagram", authorHandle: "creator", caption: "Saved clip", url: "https://example.test/reel/clip",
    videoUrl: null, thumbUrl: null, views: 0, likes: 0, comments: 0, shares: 0, saves: 0,
    durationSec: 1.5, musicId: null, musicName: null, authorFollowerCount: 0, postedAt: "2026-06-02T08:00:00Z", raw: {}, ...over,
  }) as unknown as VideoClip;
  const upsert = (clips: VideoClip[], org = orgId) => upsertVideoClips(sql, { orgId: org, instanceId, sourceKind: "account", clips });
  const snapshot = (clips: VideoClip[], org = orgId) => recordClipMetricsSnapshot(sql, {
    orgId: org, instanceId, platform: "instagram", clips, followerCount: 0,
  });
  const unknown = () => clip({ views: null, likes: null, comments: null, shares: null, saves: null, postedAt: null });

  it("allows unknown bigint counters without defaults in both physical tables", async () => {
    const rows = await sql<Array<{ is_nullable: string; column_default: string | null; data_type: string }>>`
      select is_nullable,column_default,data_type from information_schema.columns
      where table_schema='noelle' and table_name in ('video_clips','video_clip_metrics')
        and column_name in ('views','likes','comments','shares','saves')`;
    expect(rows).toHaveLength(10);
    expect(rows.every(row => row.is_nullable === "YES" && row.column_default === null && row.data_type === "bigint")).toBe(true);
  });
  it("preserves historical default-zero values when the migration is replayed", () => {
    expect(historicalZerosPreserved).toBe(true);
  });
  it("writes unknown clip counters and birth date as null", async () => {
    expect(await upsert([unknown()])).toBe(1);
    expect((await sql`select views,likes,comments,shares,saves,posted_at from noelle.video_clips`)[0]).toEqual({
      views: null, likes: null, comments: null, shares: null, saves: null, posted_at: null,
    });
  });
  it("retains measured zero and safe counts above int4", async () => {
    expect(await upsert([clip({ views: 2_147_483_648 })])).toBe(1);
    expect((await sql`select views::text,likes::text,duration_s::text from noelle.video_clips`)[0]).toEqual({ views: "2147483648", likes: "0", duration_s: "1.5" });
    expect(await snapshot([clip()])).toBe(1);
    expect((await summarizeSelfMetrics(sql, instanceId))?.avgViews).toBe(0);
  });
  it("normalizes malformed direct writer counts and impossible dates", async () => {
    expect(await upsert([clip({ views: -1, likes: 1.5, comments: "", shares: Number.MAX_SAFE_INTEGER + 1, saves: true,
      authorFollowerCount: -1, postedAt: "2026-02-30T00:00:00Z" })])).toBe(1);
    expect((await sql`select views,likes,comments,shares,saves,author_follower_count,posted_at from noelle.video_clips`)[0]).toEqual({
      views: null, likes: null, comments: null, shares: null, saves: null, author_follower_count: null, posted_at: null,
    });
  });
  it("unknown refresh cannot erase a measured saved birth date", async () => {
    await upsert([clip()]);
    await upsert([clip({ postedAt: null })]);
    expect(String((await sql`select (posted_at at time zone 'UTC')::text as birth from noelle.video_clips`)[0]!.birth)).toBe("2026-06-02 08:00:00");
  });
  it("rejects a foreign org insert and reports zero written rows", async () => {
    expect(await upsert([clip()], otherOrgId)).toBe(0);
    expect((await sql`select count(*)::int as n from noelle.video_clips`)[0]!.n).toBe(0);
  });
  it("rejects an independently valid foreign conflict without changing it", async () => {
    await sql`insert into noelle.video_clips(org_id,agent_instance_id,external_id,author_handle,caption)
      values (${otherOrgId},${instanceId},'clip','creator','Foreign original')`;
    expect(await upsert([clip()])).toBe(0);
    expect((await sql`select caption from noelle.video_clips`)[0]!.caption).toBe("Foreign original");
  });
  it("appends unknown snapshot values and computes measured-only fractional averages", async () => {
    await upsert([unknown(), clip({ id: "known", views: 3, likes: 1 }), clip({ id: "zero", views: 0, likes: 0 })]);
    expect(await snapshot([unknown(), clip({ id: "known", views: 3, likes: 1 }), clip({ id: "zero" })])).toBe(3);
    const summary = await summarizeSelfMetrics(sql, instanceId);
    expect(summary?.clips).toBe(3);
    expect(summary?.avgViews).toBe(1.5);
    expect(summary?.avgLikes).toBe(0.5);
    expect((await sql`select views from noelle.video_clip_metrics where views is null`)).toHaveLength(1);
  });
  it("rejects foreign clip snapshot references and conflicting caller platform", async () => {
    await sql`insert into noelle.video_clips(org_id,agent_instance_id,external_id,author_handle)
      values (${otherOrgId},${instanceId},'foreign','creator')`;
    await upsert([clip()]);
    expect(await snapshot([clip({ id: "foreign" }), clip({ platform: "tiktok" })])).toBe(0);
    expect((await sql`select count(*)::int as n from noelle.video_clip_metrics`)[0]!.n).toBe(0);
  });
  it("excludes legacy malformed measurements from self averages", async () => {
    await upsert([clip()]);
    await snapshot([clip()]);
    await sql`update noelle.video_clip_metrics set views=-1,likes=${String(Number.MAX_SAFE_INTEGER + 1)}`;
    const summary = await summarizeSelfMetrics(sql, instanceId);
    expect(summary?.avgViews).toBeNull();
    expect(summary?.avgLikes).toBeNull();
  });
  it("unknown view clips cannot enter the measured deep-tier population", async () => {
    await upsert([unknown(), clip({ id: "known", views: 2 })]);
    await flagDeepTier(sql, instanceId, 0);
    expect((await sql`select deep_tier from noelle.video_clips where external_id='clip'`)[0]!.deep_tier).toBe(false);
    expect((await sql`select deep_tier from noelle.video_clips where external_id='known'`)[0]!.deep_tier).toBe(true);
  });

  it("rejects a freshly changed non-Video parent without inserting clips", async () => {
    await sql`update noelle.agent_instances set role='linkedin_intern' where id=${instanceId}`;
    expect(await upsert([clip()])).toBe(0);
    expect(await sql`select id from noelle.video_clips`).toHaveLength(0);
  });
  it.each(["creator", "niche"] as const)("promotes an existing %s clip when actual account evidence arrives", async sourceKind => {
    await upsertVideoClips(sql, { orgId, instanceId, sourceKind, clips: [clip()] });
    expect(await upsert([clip({ views: 2 })])).toBe(1);
    expect((await sql`select source_kind,views::text from noelle.video_clips`)[0]).toEqual({ source_kind: "account", views: "2" });
  });
  it.each(["creator", "niche"] as const)("retains account classification during a %s refresh", async sourceKind => {
    await upsert([clip()]);
    await upsertVideoClips(sql, { orgId, instanceId, sourceKind, clips: [clip({ views: 2 })] });
    expect((await sql`select source_kind,views::text from noelle.video_clips`)[0]).toEqual({ source_kind: "account", views: "2" });
  });
  it("preserves the existing non-account refresh classification", async () => {
    await upsertVideoClips(sql, { orgId, instanceId, sourceKind: "creator", clips: [clip()] });
    await upsertVideoClips(sql, { orgId, instanceId, sourceKind: "niche", clips: [clip()] });
    expect((await sql`select source_kind from noelle.video_clips`)[0]?.source_kind).toBe("creator");
  });
  it.each(["org", "role"])("revalidates the current parent %s after a conflicting row lock", async field => {
    let release!: () => void; let ready!: () => void;
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const parent = sql.begin(async tx => {
      if (field === "org") await tx`update noelle.agent_instances set org_id=${otherOrgId} where id=${instanceId}`;
      else await tx`update noelle.agent_instances set role='linkedin_intern' where id=${instanceId}`;
      ready(); await unlocked;
    });
    await locked;
    let settled = false;
    const writing = upsert([clip()]).then(n => { settled = true; return n; });
    try { await new Promise(resolve => setTimeout(resolve, 40)); expect(settled).toBe(false); }
    finally { release(); await parent; }
    expect(await writing).toBe(0);
    expect(await sql`select id from noelle.video_clips`).toHaveLength(0);
  });
});

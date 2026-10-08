import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as Sql, instance: { id: "", org_id: "" } }));
vi.mock("@/lib/db", () => ({ readSql: (...args: unknown[]) => Reflect.apply(fixture.sql, undefined, args) }));
vi.mock("@/lib/queries", () => ({ getAgentInstance: () => fixture.instance }));
import { getVideoClipDetail, listVideoClips } from "./video-queries";
import { getInspirationClips, listTopInspirationClips } from "./video-studio-queries";
import { getOwnAccountAnalytics } from "./video-analytics-queries";

const url = process.env.NOELLE_VIDEO_METRICS_TEST_DATABASE_URL;
describe.skipIf(!url)("dashboard Video measurements (native PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = fixture.sql = postgres(url!, { max: 1, onnotice: () => {} });
    if (!String((await sql`select current_database() as name`)[0]?.name).includes("video_metrics_test")) throw new Error("dedicated Video metrics test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0065_video_intern_watchlist.sql", "0066_video_intern_corpus.sql", "0067_video_intern_studio.sql", "0073_video_self_tracking.sql", "0120_video_metrics_nullable.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    fixture.instance.org_id = String((await sql`insert into noelle.organizations(slug,name) values ('dashboard_video','Dashboard Video') returning id`)[0]!.id);
    fixture.instance.id = String((await sql`insert into noelle.agent_instances(org_id,role) values (${fixture.instance.org_id},'video_intern') returning id`)[0]!.id);
    await sql`insert into noelle.video_watchlist_sources(org_id,agent_instance_id,handle,is_own,created_at)
      values (${fixture.instance.org_id},${fixture.instance.id},'example',true,'2026-06-01T00:00:00Z')`;
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  async function insert(id: string, views: string | null, likes: string | null = null) {
    const [row] = await sql`insert into noelle.video_clips(org_id,agent_instance_id,external_id,source_kind,author_handle,
      caption,url,views,likes,comments,shares,saves,author_follower_count,duration_s)
      values (${fixture.instance.org_id},${fixture.instance.id},${id},'account','example',${id},'https://example.test/clip',
        ${views},${likes},null,null,null,100,1.5) returning id`;
    return String(row!.id);
  }
  it("lists native bigint measurements before unknown and preserves measured zero", async () => {
    await insert("unknown", null); await insert("zero", "0", "0"); await insert("large", "2147483648", "1");
    expect((await listVideoClips(fixture.instance.id)).map(c => [c.external_id, c.views]))
      .toEqual([["large", 2147483648], ["zero", 0], ["unknown", null]]);
  });
  it("keeps unknown detail counts and fractional duration", async () => {
    const id = await insert("unknown", null);
    expect(await getVideoClipDetail(fixture.instance.id, id)).toMatchObject({ views: null, likes: null, comments: null,
      shares: null, saves: null, posted_at: null, duration_sec: 1.5 });
  });
  it("uses the same normalization for explicit and fallback inspirations", async () => {
    const id = await insert("unknown", null);
    const expected = { views: null, likes: null, comments: null, reach_multiple: null, author_follower_count: 100 };
    expect((await getInspirationClips(fixture.instance.id, [id])).get(id)).toMatchObject(expected);
    expect((await listTopInspirationClips(fixture.instance.id))[0]).toMatchObject(expected);
  });
  it("renders legacy negative and unsafe native counters as unknown", async () => {
    const id = await insert("legacy", "-1", "9223372036854775807");
    expect(await getVideoClipDetail(fixture.instance.id, id)).toMatchObject({ views: null, likes: null });
  });
  it("keeps analytics unknowns and refuses a growth delta from an unknown endpoint", async () => {
    const id = await insert("unknown", null);
    await sql`insert into noelle.video_clip_metrics(org_id,agent_instance_id,clip_id,views,likes,comments,shares,saves,captured_at)
      values (${fixture.instance.org_id},${fixture.instance.id},${id},null,null,null,null,null,'2026-06-01T00:00:00Z'),
        (${fixture.instance.org_id},${fixture.instance.id},${id},0,0,0,0,0,'2026-06-02T00:00:00Z')`;
    expect((await getOwnAccountAnalytics(fixture.instance.id)).posts[0]).toMatchObject({ views: null, likes: null,
      comments: null, shares: null, saves: null, reachMultiple: null, viewsGained: null });
  });
  it("retains measured zero analytics and zero ratio", async () => {
    await insert("zero", "0", "0");
    expect((await getOwnAccountAnalytics(fixture.instance.id)).posts[0]).toMatchObject({ views: 0, likes: 0, reachMultiple: 0 });
  });
  it("aligns posts and followers with the selected primary handle/platform", async () => {
    const primary = await insert("primary", "10"); const secondary = await insert("secondary", "100");
    await sql`update noelle.video_clips set platform='tiktok' where id=${secondary}`;
    await sql`insert into noelle.video_watchlist_sources(org_id,agent_instance_id,platform,handle,is_own,created_at)
      values (${fixture.instance.org_id},${fixture.instance.id},'tiktok','example',true,'2026-06-02T00:00:00Z')`;
    await sql`insert into noelle.video_clip_metrics(org_id,agent_instance_id,clip_id,author_follower_count,captured_at)
      values (${fixture.instance.org_id},${fixture.instance.id},${primary},100,'2026-06-03T08:00:00Z'),
        (${fixture.instance.org_id},${fixture.instance.id},${secondary},1000,'2026-06-03T09:00:00Z'),
        (${fixture.instance.org_id},${fixture.instance.id},${primary},110,'2026-06-04T08:00:00Z')`;
    const analytics = await getOwnAccountAnalytics(fixture.instance.id);
    expect(analytics.platform).toBe("instagram"); expect(analytics.posts.map(post => post.id)).toEqual([primary]);
    expect(analytics.followerSeries.map(point => point.followerCount)).toEqual([100, 110]);
    expect(analytics.followerDelta).toBe(10);
  });
  it("does not fall back to disabled-source metrics", async () => {
    const id = await insert("disabled", "10");
    await sql`update noelle.video_watchlist_sources set enabled=false`;
    await sql`insert into noelle.video_clip_metrics(org_id,agent_instance_id,clip_id,author_follower_count)
      values (${fixture.instance.org_id},${fixture.instance.id},${id},100)`;
    expect(await getOwnAccountAnalytics(fixture.instance.id)).toMatchObject({ handle: null, platform: null, posts: [], followerCount: null, followerDelta: null });
  });
});

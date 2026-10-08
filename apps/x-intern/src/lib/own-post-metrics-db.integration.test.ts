import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getOwnPostPerformance, listPublishedTweetsForMetrics, recordOwnPostMetrics } from "./own-post-metrics-db.js";

const url = process.env.NOELLE_METRICS_TEST_DATABASE_URL;
const instance = "00000000-0000-4000-8000-000000000001";
const org = "00000000-0000-4000-8000-000000000002";
const idea = "00000000-0000-4000-8000-000000000003";
const migration = readFileSync(new URL("../../../../infra/cloudsql/schema/0111_x_content_outcomes.sql", import.meta.url), "utf8");

describe.skipIf(!url)("X content outcome storage (PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    const [row] = await sql`select current_database() as db`;
    if (!row?.db.includes("test")) throw new Error("Metrics integration requires an isolated test database");
  });
  beforeEach(async () => {
    await sql`drop schema if exists noelle cascade`;
    await sql`create schema noelle`;
    await sql`create table noelle.own_post_metrics (
      id uuid primary key default gen_random_uuid(), org_id uuid, agent_instance_id uuid,
      platform text, external_id text, slot_id uuid, idea_id uuid,
      captured_at timestamptz default now(), likes bigint, reposts bigint, replies bigint,
      views bigint, author_follower_count bigint
    )`;
    await sql`create table noelle.post_ideas (id uuid primary key, hook text, pillar text, angle text)`;
    await sql`create table noelle.content_schedule_slots (
      id uuid primary key default gen_random_uuid(), agent_instance_id uuid, platform text,
      status text, posted_tweet_id text, posted_url text, idea_id uuid, published_at timestamptz
    )`;
    await sql`create table noelle.post_drafts (
      id uuid primary key default gen_random_uuid(), agent_instance_id uuid, platform text,
      status text, posted_url text, idea_id uuid, updated_at timestamptz
    )`;
    await sql.unsafe(migration);
    await sql.unsafe(migration);
    await sql`insert into noelle.post_ideas values (${idea}, 'measured hook', 'craft', 'example')`;
  });
  afterAll(async () => { await sql?.end(); });

  async function snapshot(over: { views?: number | null; likes?: number; quotes?: number | null; bookmarks?: number | null } = {}) {
    await recordOwnPostMetrics(sql, [{
      orgId: org, instanceId: instance, externalId: "1", slotId: null, ideaId: idea,
      likes: over.likes ?? 10, reposts: 2, replies: 3, views: over.views ?? null,
      authorFollowerCount: null, quotes: over.quotes, bookmarks: over.bookmarks,
    }]);
  }

  it("applies the migration twice and preserves unavailable versus zero outcomes", async () => {
    await snapshot({ quotes: 0, bookmarks: null });
    await snapshot({ quotes: null, bookmarks: 0 });
    const rows = await sql`select quotes, bookmarks from noelle.own_post_metrics order by captured_at`;
    expect(rows.map((r) => [r.quotes, r.bookmarks])).toEqual([["0", null], [null, "0"]]);
  });

  it("keeps exposure and engagement from the same snapshot when Apify later records larger counts", async () => {
    await snapshot({ views: 1000, likes: 20, quotes: 4, bookmarks: 5 });
    await snapshot({ likes: 100 });
    const perf = await getOwnPostPerformance(sql, { instanceId: instance, windowDays: 30, topPosts: 5 });
    expect(perf.topPosts[0]?.likes).toBe(20);
    expect(perf.topPosts[0]?.views).toBe(1000);
    expect(perf.topPosts[0]?.quotes).toBe(4);
  });

  it("uses the latest count snapshot when exposure is unavailable", async () => {
    await snapshot({ likes: 20 });
    await snapshot({ likes: 30 });
    const perf = await getOwnPostPerformance(sql, { instanceId: instance, windowDays: 30, topPosts: 5 });
    expect(perf.topPosts[0]?.likes).toBe(30);
    expect(perf.topPosts[0]?.views).toBeNull();
    expect(perf.topPosts[0]?.quotes).toBeNull();
  });

  it("captures core metrics safely before the additive outcome columns are migrated", async () => {
    await sql`alter table noelle.own_post_metrics drop column quotes, drop column bookmarks`;
    await snapshot({ views: 1000, quotes: 4, bookmarks: 3 });
    const perf = await getOwnPostPerformance(sql, { instanceId: instance, windowDays: 30, topPosts: 5 });
    expect(perf.topPosts[0]?.likes).toBe(10);
    expect(perf.topPosts[0]?.views).toBe(1000);
    expect(perf.topPosts[0]?.quotes).toBeNull();
    expect(perf.topPosts[0]?.bookmarks).toBeNull();
    expect(await listPublishedTweetsForMetrics(sql, { instanceId: instance, windowDays: 30, limit: 2 })).toEqual([]);
  });

  it("bounds the learning population by newest observed posts", async () => {
    await snapshot();
    await sql`insert into noelle.own_post_metrics
      (org_id, agent_instance_id, platform, external_id, idea_id, captured_at, likes, reposts, replies)
      values (${org}, ${instance}, 'x', '2', ${idea}, now() + interval '1 second', 40, 0, 0)`;
    const perf = await getOwnPostPerformance(sql, { instanceId: instance, windowDays: 30, topPosts: 5, maxPosts: 1 });
    expect(perf.topPosts).toHaveLength(1);
    expect(perf.topPosts[0]?.likes).toBe(40);
  });

  it("deduplicates published IDs and rotates towards unmeasured posts within the SQL limit", async () => {
    await sql`insert into noelle.content_schedule_slots
      (agent_instance_id, platform, status, posted_tweet_id, posted_url, idea_id, published_at)
      values (${instance}, 'x', 'published', '1', 'https://x.com/me/status/1', ${idea}, now()),
             (${instance}, 'x', 'published', '2', 'https://x.com/me/status/2', ${idea}, now())`;
    await sql`insert into noelle.post_drafts
      (agent_instance_id, platform, status, posted_url, idea_id, updated_at)
      values (${instance}, 'x', 'published', 'https://x.com/me/status/1', ${idea}, now())`;
    await snapshot({ views: 1000 });
    const posts = await listPublishedTweetsForMetrics(sql, { instanceId: instance, windowDays: 30, limit: 1 });
    expect(posts.map((p) => p.tweetId)).toEqual(["2"]);
    expect(await listPublishedTweetsForMetrics(sql, { instanceId: instance, windowDays: 30, limit: 0 })).toEqual([]);
  });
});

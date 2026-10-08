import postgres, { type Sql } from "postgres";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertStylePosts, getAccountCorpus, listStyleExemplars, listStyleExemplarsForHandle,
  listUnembeddedStylePosts, updateStylePostEmbeddings, upsertAccountUltraProfile } from "./accountFeederDb.js";

const url = process.env.NOELLE_CORPUS_METRICS_TEST_DATABASE_URL;

describe.skipIf(!url)("account corpus measurements (native PostgreSQL)", () => {
  let sql: Sql;
  let orgId: string;
  let instanceId: string;
  let historicalZeroRetained = false;
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    const [db] = await sql`select current_database() as name`;
    if (!String(db?.name).includes("account_corpus_metrics_test")) throw new Error("dedicated corpus metrics test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0051_account_feeder.sql", "0052_account_style_embeddings.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
    const migration = new URL("../../../infra/cloudsql/schema/0119_account_corpus_metrics_nullable.sql", import.meta.url);
    const [historicalOrg] = await sql`insert into noelle.organizations(slug,name) values ('historical','Historical') returning id`;
    const [historicalInstance] = await sql`insert into noelle.agent_instances(org_id,role) values (${historicalOrg!.id},'x_intern') returning id`;
    await sql`insert into noelle.account_style_posts(org_id,agent_instance_id,platform,account_handle,external_id,body)
      values (${historicalOrg!.id},${historicalInstance!.id},'x','source','historical','Historical saved source')`;
    if (existsSync(migration)) {
      const ddl = await readFile(migration, "utf8");
      await sql.unsafe(ddl);
      await sql.unsafe(ddl);
    }
    const [historical] = await sql`select like_count::text,comment_count::text from noelle.account_style_posts where external_id='historical'`;
    historicalZeroRetained = historical?.like_count === "0" && historical?.comment_count === "0";
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    const [org] = await sql`insert into noelle.organizations(slug,name) values ('corpus_test','Corpus test') returning id`;
    orgId = String(org!.id);
    const [instance] = await sql`insert into noelle.agent_instances(org_id,role) values (${orgId},'x_intern') returning id`;
    instanceId = String(instance!.id);
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });

  const row = (over: Record<string, unknown> = {}) => ({ orgId, agentInstanceId: instanceId,
    platform: "x", accountHandle: "source", externalId: "post", kind: "post" as const,
    body: "Saved source text", likeCount: 0, commentCount: 0, raw: {}, postedAt: null, ...over });
  const write = (over: Record<string, unknown> = {}) => upsertStylePosts(sql, [row(over)] as Parameters<typeof upsertStylePosts>[1]);

  it("persists unknown counts as null", async () => {
    expect(await write({ likeCount: null, commentCount: null })).toBe(1);
    const [saved] = await sql`select like_count,comment_count from noelle.account_style_posts`;
    expect(saved).toEqual({ like_count: null, comment_count: null });
  });
  it("preserves historical zero when the nullable migration is applied and replayed", () => {
    expect(historicalZeroRetained).toBe(true);
  });
  it("retains measured zero", async () => {
    expect(await write()).toBe(1);
    const [saved] = await sql`select like_count::text,comment_count::text from noelle.account_style_posts`;
    expect(saved).toEqual({ like_count: "0", comment_count: "0" });
  });
  it("persists valid measured counts above int4 and normalizes driver strings", async () => {
    const count = 2 ** 31;
    expect(await write({ likeCount: count, commentCount: count })).toBe(1);
    const corpus = await getAccountCorpus(sql, { agentInstanceId: instanceId, platform: "x", accountHandle: "source", limit: 10 });
    expect([corpus[0]?.likeCount, corpus[0]?.commentCount]).toEqual([count, count]);
  });
  it("persists valid measured repost counts above int4", async () => {
    expect(await write({ repostCount: 2 ** 31 })).toBe(1);
    expect((await sql`select repost_count::text from noelle.account_style_posts`)[0]?.repost_count).toBe("2147483648");
  });
  it("does not erase a measured posted timestamp on an unknown later pull", async () => {
    await write({ postedAt: "2026-06-01T00:00:00Z" });
    await write({ postedAt: null });
    const [saved] = await sql`select posted_at::text as posted_at from noelle.account_style_posts`;
    expect(saved?.posted_at).not.toBeNull();
  });
  it("does not admit a foreign org soft reference to the instance", async () => {
    const [other] = await sql`insert into noelle.organizations(slug,name) values ('foreign','Foreign') returning id`;
    expect(await write({ orgId: String(other!.id) })).toBe(0);
    expect((await sql`select count(*)::int as n from noelle.account_style_posts`)[0]?.n).toBe(0);
  });
  it("does not overwrite a native malformed existing owner on conflict", async () => {
    const [other] = await sql`insert into noelle.organizations(slug,name) values ('foreign','Foreign') returning id`;
    await sql`insert into noelle.account_style_posts(org_id,agent_instance_id,platform,account_handle,external_id,body)
      values (${other!.id},${instanceId},'x','source','post','Foreign saved body')`;
    expect(await write()).toBe(0);
    expect((await sql`select body from noelle.account_style_posts`)[0]?.body).toBe("Foreign saved body");
  });
  it("ignores empty input", async () => {
    expect(await upsertStylePosts(sql, [])).toBe(0);
  });
  const corpus = () => getAccountCorpus(sql, { agentInstanceId: instanceId, platform: "x", accountHandle: "source", limit: 10 });
  const pool = (floor = 0) => listStyleExemplars(sql, { agentInstanceId: instanceId, platform: "x", kind: "post", limit: 10, minPerformancePercentile: floor });
  const source = (enabled = true) => sql`insert into noelle.account_feeder_sources(org_id,agent_instance_id,platform,handle,enabled)
    values (${orgId},${instanceId},'x','source',${enabled})`;

  it("normalizes malformed legacy counters and ranks measured zero ahead of unknown", async () => {
    await write({ externalId: "unknown", likeCount: null, commentCount: null });
    await write({ externalId: "zero" });
    await write({ externalId: "legacy" });
    await sql`update noelle.account_style_posts set like_count=-1,comment_count=9007199254740992 where external_id='legacy'`;
    const items = await corpus();
    expect(items[0]?.externalId).toBe("zero");
    expect(items.find(item => item.externalId === "legacy")).toMatchObject({ likeCount: null, commentCount: null });
    expect((await listUnembeddedStylePosts(sql, instanceId, 10))[0]?.id).toBe(String((await sql`select id from noelle.account_style_posts where external_id='zero'`)[0]!.id));
  });
  it("requires measured performance for a positive floor and retains measured singleton zero", async () => {
    await source();
    await write({ externalId: "unknown", likeCount: null, commentCount: null });
    expect(await pool(100)).toEqual([]);
    await write({ externalId: "zero" });
    expect((await pool(100)).map(item => item.external_id)).toEqual(["zero"]);
    expect((await pool(0)).map(item => item.external_id)).toEqual(["zero", "unknown"]);
  });
  it("keeps pinned disabled sources usable without enabling the automatic pool", async () => {
    await source(false);
    await write({ likeCount: null, commentCount: null });
    expect(await pool()).toEqual([]);
    const pinned = await listStyleExemplarsForHandle(sql, { agentInstanceId: instanceId, platform: "x", kind: "post", handle: "SOURCE", limit: 10 });
    expect(pinned[0]).toMatchObject({ like_count: null, comment_count: null });
  });
  it("excludes incoherent native rows from corpus, unembedded and exemplar readers and embedding writes", async () => {
    await source();
    const [other] = await sql`insert into noelle.organizations(slug,name) values ('foreign','Foreign') returning id`;
    const [bad] = await sql`insert into noelle.account_style_posts(org_id,agent_instance_id,platform,account_handle,external_id,body)
      values (${other!.id},${instanceId},'x','source','foreign','Foreign saved body') returning id`;
    expect(await corpus()).toEqual([]);
    expect(await pool()).toEqual([]);
    expect(await listUnembeddedStylePosts(sql, instanceId, 10)).toEqual([]);
    expect(await updateStylePostEmbeddings(sql, [{ id: String(bad!.id), body: "Foreign saved body", embedding: Array(1024).fill(0) as number[] }])).toBe(0);
  });
  it("writes a valid embedding once and exposes it through the canonical exemplar reader", async () => {
    await source();
    await write();
    const [post] = await listUnembeddedStylePosts(sql, instanceId, 10);
    const embedding = Array(1024).fill(0) as number[];
    embedding[0] = 1;
    expect(await updateStylePostEmbeddings(sql, [{ ...post!, embedding }])).toBe(1);
    expect((await pool())[0]?.embedding).toEqual(embedding);
    expect(await listUnembeddedStylePosts(sql, instanceId, 10)).toEqual([]);
  });
  it("clears the vector when a refresh replaces the embedded body", async () => {
    await write();
    const [post] = await listUnembeddedStylePosts(sql, instanceId, 1);
    await updateStylePostEmbeddings(sql, [{ ...post!, embedding: [1, ...Array<number>(1023).fill(0)] }]);
    await write({ body: "Replacement source text" });
    expect((await sql`select embedding from noelle.account_style_posts`)[0]?.embedding).toBeNull();
    expect((await listUnembeddedStylePosts(sql, instanceId, 1))[0]?.body).toBe("Replacement source text");
  });
  it("keeps the current vector during a metrics-only refresh", async () => {
    await write();
    const [post] = await listUnembeddedStylePosts(sql, instanceId, 1);
    await updateStylePostEmbeddings(sql, [{ ...post!, embedding: [1, ...Array<number>(1023).fill(0)] }]);
    await write({ likeCount: 12 });
    expect((await sql`select embedding from noelle.account_style_posts`)[0]?.embedding).not.toBeNull();
    expect(await listUnembeddedStylePosts(sql, instanceId, 1)).toEqual([]);
  });
  it("rejects a vector whose captured body changed before the embedding result arrived", async () => {
    await write();
    const [post] = await listUnembeddedStylePosts(sql, instanceId, 1);
    await write({ body: "Replacement source text" });
    expect(await updateStylePostEmbeddings(sql, [{ ...post!, embedding: [1, ...Array<number>(1023).fill(0)] }])).toBe(0);
    expect((await sql`select embedding from noelle.account_style_posts`)[0]?.embedding).toBeNull();
  });
  it("rechecks captured text after waiting for a concurrent body replacement", async () => {
    await write();
    const [post] = await listUnembeddedStylePosts(sql, instanceId, 1);
    let release!: () => void;
    let acquired!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const changing = sql.begin(async tx => {
      await tx`update noelle.account_style_posts set body='Replacement source text' where id=${post!.id}`;
      acquired(); await unlocked;
    });
    await locked;
    let finished = false;
    const storing = updateStylePostEmbeddings(sql, [{ ...post!, embedding: [1, ...Array<number>(1023).fill(0)] }])
      .finally(() => { finished = true; });
    const observer = postgres(url!, { max: 1 });
    try {
      await vi.waitFor(async () => {
        expect(finished).toBe(false);
        const [waiting] = await observer`select count(*)::int as n from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and query like '%set embedding%'`;
        expect(waiting?.n).toBeGreaterThan(0);
      });
    } finally {
      release();
      try { await changing; await storing; } finally { await observer.end({ timeout: 0 }); }
    }
    expect(await storing).toBe(0);
    expect((await sql`select embedding from noelle.account_style_posts`)[0]?.embedding).toBeNull();
  });
  const profile = () => ({ orgId, agentInstanceId: instanceId, platform: "x", accountHandle: "source",
    voiceSummary: "Saved writing style", tone: "direct", structureNotes: "short paragraphs",
    hookPatterns: [], signaturePhrases: [], topTopics: [], avgLikeCount: null, avgCommentCount: null,
    postsAnalyzed: 1, samplePostIds: [], model: "test" });

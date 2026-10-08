import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ sql: null as unknown as Sql, signedIn: true, afterLookup: null as null | (() => Promise<void>) }));
const org = "00000000-0000-4000-8000-000000000001";
const foreignOrg = "00000000-0000-4000-8000-000000000002";
const redditInstance = "00000000-0000-4000-8000-000000000013";
const foreignInstance = "00000000-0000-4000-8000-000000000016";
vi.mock("@/lib/db", () => ({ sql: Object.assign((...args: unknown[]) => Reflect.apply(fixture.sql, undefined, args), {
  begin: (fn: (tx: TransactionSql) => Promise<unknown>) => fixture.sql.begin(fn),
}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/queries", () => ({
  getCurrentUser: async () => fixture.signedIn ? { id: "fixture-member" } : null,
  getOrgBySlug: async (slug: string) => slug === "fixture" ? { id: org, slug } : null,
  getAgentInstance: async (id: string) => {
    const row = (await fixture.sql`select * from noelle.agent_instances where id=${id}`)[0] ?? null;
    const hook = fixture.afterLookup; fixture.afterLookup = null; await hook?.(); return row;
  },
}));
import { pauseAllSending } from "@/app/app/[orgSlug]/agents/[instanceId]/actions";
import { addRedditWatchlistEntry, removeRedditWatchlistEntry } from "@/app/app/[orgSlug]/agents/[instanceId]/reddit-watchlist-actions";

const url = process.env.NOELLE_DASHBOARD_CONTROLS_TEST_DATABASE_URL;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const flags = ["send_enabled", "reply_send_enabled", "auto_send_enabled", "x_api_write_enabled"] as const;
describe.skipIf(!url)("dashboard sending controls (dedicated native PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = postgres(url!, { max: 12, onnotice: () => {} });
    const [row] = await sql<{ db: string }[]>`select current_database() as db`;
    if (!row?.db.endsWith("_dashboard_controls_test")) throw new Error("Dedicated dashboard controls test database required");
    fixture.sql = sql;
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0015_auto_send.sql", "0019_worker_enabled.sql", "0054_reddit_watchlist.sql", "0075_x_api_write.sql", "0081_reply_send_enabled.sql"])
      await sql.unsafe(readFileSync(resolve(repo, "infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    fixture.afterLookup = null;
    fixture.signedIn = true;
    await sql`drop trigger if exists reject_pause on noelle.agent_instances`;
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${org},'fixture','Fixture'),(${foreignOrg},'foreign','Foreign')`;
    await sql`insert into noelle.agent_instances(id,org_id,role,send_enabled,reply_send_enabled,auto_send_enabled,x_api_write_enabled) values
      ('00000000-0000-4000-8000-000000000011',${org},'x_intern',true,false,false,false),
      ('00000000-0000-4000-8000-000000000012',${org},'linkedin_intern',false,true,false,false),
      (${redditInstance},${org},'reddit_intern',false,false,true,false),
      ('00000000-0000-4000-8000-000000000014',${org},'video_intern',false,false,false,true),
      ('00000000-0000-4000-8000-000000000015',${org},'ceo',true,true,true,true),
      (${foreignInstance},${foreignOrg},'x_intern',true,true,true,true)`;
  });
  afterAll(async () => { await sql?.end(); });
  async function states() {
    return sql`select role,org_id,send_enabled,reply_send_enabled,auto_send_enabled,x_api_write_enabled from noelle.agent_instances order by id`;
  }

  it.each(["add-role", "add-org", "remove-role", "remove-org"] as const)("rechecks the Reddit parent after committed %s rebinding", async (variant) => {
    const [row] = await sql`insert into noelle.reddit_watchlist(org_id,agent_instance_id,subreddit) values (${org},${redditInstance},'existing') returning id`;
    fixture.afterLookup = async () => {
      if (variant.endsWith("role")) await sql`update noelle.agent_instances set role='role-rebound' where id=${redditInstance}`;
      else await sql`update noelle.agent_instances set org_id=${foreignOrg} where id=${redditInstance}`;
    };
    const base = { orgSlug: "fixture", instanceId: redditInstance };
    const result = variant.startsWith("add") ? await addRedditWatchlistEntry({ ...base, subreddit: "newtarget" }) : await removeRedditWatchlistEntry({ ...base, rowId: row!.id });
    expect(result).toMatchObject({ ok: false, error: "not_found" });
    expect(await sql`select subreddit from noelle.reddit_watchlist order by subreddit`).toEqual([{ subreddit: "existing" }]);
  });
  it("removes a scoped row and refuses absent or foreign rows", async () => {
    const [own] = await sql`insert into noelle.reddit_watchlist(org_id,agent_instance_id,subreddit) values (${org},${redditInstance},'owned') returning id`;
    const [foreign] = await sql`insert into noelle.reddit_watchlist(org_id,agent_instance_id,subreddit) values (${foreignOrg},${foreignInstance},'foreign') returning id`;
    const base = { orgSlug: "fixture", instanceId: redditInstance };
    expect(await removeRedditWatchlistEntry({ ...base, rowId: own!.id })).toEqual({ ok: true });
    expect(await removeRedditWatchlistEntry({ ...base, rowId: own!.id })).toMatchObject({ ok: false });
    expect(await removeRedditWatchlistEntry({ ...base, rowId: foreign!.id })).toMatchObject({ ok: false });
    expect(await sql`select subreddit from noelle.reddit_watchlist`).toEqual([{ subreddit: "foreign" }]);
  });

  it("pauses every supported consent including master-only rows without touching a foreign org or coordinator", async () => {
    expect(await pauseAllSending({ orgSlug: "fixture" })).toEqual({ ok: true, paused: 4 });
    const rows = await states();
    for (const row of rows) {
      const expected = row.org_id !== org || row.role === "ceo";
      for (const flag of flags) expect(row[flag], `${row.role}:${row.org_id}:${flag}`).toBe(expected);
    }
    expect(await pauseAllSending({ orgSlug: "fixture" })).toEqual({ ok: true, paused: 0 });
  });
  it("twelve concurrent pause calls count each changed intern once", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => pauseAllSending({ orgSlug: "fixture" })));
    expect(results.filter((result) => result.ok && result.paused === 4)).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.paused === 0)).toHaveLength(11);
  });
  it("a native update failure rolls back every sending switch and does not acknowledge success", async () => {
    await sql.unsafe("create or replace function noelle.reject_pause() returns trigger language plpgsql as $$ begin if new.role='reddit_intern' then raise exception 'fixture write rejected'; end if; return new; end $$");
    await sql.unsafe("create trigger reject_pause before update on noelle.agent_instances for each row execute function noelle.reject_pause()");
    const before = await states();
    await expect(pauseAllSending({ orgSlug: "fixture" })).rejects.toThrow("fixture write rejected");
    expect(await states()).toEqual(before);
  });
  it("an unauthenticated pause cannot change stored switches", async () => {
    fixture.signedIn = false;
    const before = await states();
    expect(await pauseAllSending({ orgSlug: "fixture" })).toMatchObject({ ok: false });
    expect(await states()).toEqual(before);
  });

  it("an omitted Reddit score persists the native zero floor", async () => {
    expect(await addRedditWatchlistEntry({ orgSlug: "fixture", instanceId: redditInstance, subreddit: "r/testingblank" })).toEqual({ ok: true });
    const [row] = await sql`select subreddit,min_score from noelle.reddit_watchlist`;
    expect(row).toEqual({ subreddit: "testingblank", min_score: 0 });
  });
  it("twelve concurrent normalized additions form one native watchlist row", async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => addRedditWatchlistEntry({
      orgSlug: "fixture", instanceId: redditInstance, subreddit: "r/TestingConcurrent", minScore: 0,
    })));
    expect(results.every((result) => result.status === "fulfilled" && result.value.ok)).toBe(true);
    expect(await sql`select subreddit,min_score from noelle.reddit_watchlist`).toEqual([{ subreddit: "testingconcurrent", min_score: 0 }]);
  });
  it("a foreign instance cannot gain a watchlist row through a tenant slug", async () => {
    expect(await addRedditWatchlistEntry({ orgSlug: "fixture", instanceId: foreignInstance, subreddit: "testingforeign", minScore: 0 })).toMatchObject({ ok: false });
    expect(await sql`select id from noelle.reddit_watchlist`).toHaveLength(0);
  });
  it("an existing native row retains its identity while operator guidance and score are updated", async () => {
    await addRedditWatchlistEntry({ orgSlug: "fixture", instanceId: redditInstance, subreddit: "testingexisting", minScore: 7 });
    const [before] = await sql`select id,added_at from noelle.reddit_watchlist`;
    expect(await addRedditWatchlistEntry({ orgSlug: "fixture", instanceId: redditInstance, subreddit: "r/testingexisting", objective: "Specific useful replies", minScore: 9 })).toEqual({ ok: true });
    const [after] = await sql`select id,added_at,objective,min_score from noelle.reddit_watchlist`;
    expect(after).toEqual({ ...before, objective: "Specific useful replies", min_score: 9 });
  });
  it("a contradictory foreign-org watchlist soft reference cannot be overwritten", async () => {
    await sql`insert into noelle.reddit_watchlist(org_id,agent_instance_id,subreddit,objective,min_score)
      values (${foreignOrg},${redditInstance},'testingmismatch','Foreign guidance',99)`;
    const before = await sql`select * from noelle.reddit_watchlist`;
    expect(await addRedditWatchlistEntry({ orgSlug: "fixture", instanceId: redditInstance, subreddit: "testingmismatch", objective: "New guidance", minScore: 0 })).toMatchObject({ ok: false });
    expect(await sql`select * from noelle.reddit_watchlist`).toEqual(before);
  });
});

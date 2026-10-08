import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ sql: null as unknown as Sql, beforeWrite: null as null | (() => Promise<void>) }));
const org = "00000000-0000-4000-8000-000000000001", foreignOrg = "00000000-0000-4000-8000-000000000002";
const x = "00000000-0000-4000-8000-000000000011", linkedin = "00000000-0000-4000-8000-000000000012";
const reddit = "00000000-0000-4000-8000-000000000013", ceo = "00000000-0000-4000-8000-000000000014", foreign = "00000000-0000-4000-8000-000000000021";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/queries", () => ({ getCurrentUser: async () => ({ id: "fixture-member" }), getOrgBySlug: async (slug: string) => slug === "fixture" ? { id: org } : null }));
vi.mock("@/lib/db", () => ({ sql: Object.assign((...args: unknown[]) => Reflect.apply(fixture.sql, undefined, args), {
  begin: async (fn: (tx: TransactionSql) => Promise<unknown>) => { const hook = fixture.beforeWrite; fixture.beforeWrite = null; await hook?.(); return fixture.sql.begin(fn); },
}) }));
import { applyTargetingChange } from "./agent-targeting";

const url = process.env.NOELLE_DASHBOARD_TARGETING_TEST_DATABASE_URL;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
describe.skipIf(!url)("targeting writes (dedicated native schemas)", () => {
  let sql: Sql;
  const apply = (instanceId: string, proposal: unknown) => applyTargetingChange({ orgSlug: "fixture", instanceId, proposal });
  beforeAll(async () => {
    sql = postgres(url!, { max: 8, onnotice: () => {} });
    const [row] = await sql`select current_database() as db`;
    if (!row?.db.endsWith("_dashboard_targeting_test")) throw new Error("Dedicated dashboard targeting test database required");
    fixture.sql = sql;
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0004_drafts_sent_at.sql", "0003_x_watchlist.sql", "0017_agent_objective.sql", "0027_linkedin_watchlist_people.sql", "0054_reddit_watchlist.sql"])
      await sql.unsafe(readFileSync(resolve(repo, "infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    fixture.beforeWrite = null;
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${org},'fixture','Fixture'),(${foreignOrg},'foreign','Foreign')`;
    await sql`insert into noelle.agent_instances(id,org_id,role) values (${x},${org},'x_intern'),(${linkedin},${org},'linkedin_intern'),(${reddit},${org},'reddit_intern'),(${ceo},${org},'ceo'),(${foreign},${foreignOrg},'reddit_intern')`;
  });
  afterAll(async () => { await sql?.end(); });
  async function counts() {
    const [row] = await sql`select (select count(*)::int from noelle.x_watchlist) as x, (select count(*)::int from noelle.linkedin_watchlist_people) as linkedin, (select count(*)::int from noelle.reddit_watchlist) as reddit`;
    return row;
  }
  it("persists normalized Reddit targets and the mission together", async () => {
    const result = await apply(reddit, { mission: "Meet founders", addSubreddits: ["r/SaaS", "saas", "https://reddit.com/r/Startups/"] });
    expect(result).toMatchObject({ ok: true, applied: { addedSubreddits: 2, missionChanged: true } });
    expect(await sql`select subreddit,min_score from noelle.reddit_watchlist order by subreddit`).toEqual([{ subreddit: "saas", min_score: 0 }, { subreddit: "startups", min_score: 0 }]);
    expect((await sql`select objective from noelle.agent_instances where id=${reddit}`)[0]?.objective).toBe("Meet founders");
    expect(await counts()).toEqual({ x: 0, linkedin: 0, reddit: 2 });
  });
  it("removes only scoped Reddit rows and reports actual additions/removals", async () => {
    await sql`insert into noelle.reddit_watchlist(org_id,agent_instance_id,subreddit,objective,min_score) values (${org},${reddit},'saas','Keep this steer',17),(${foreignOrg},${foreign},'saas',null,0)`;
    expect(await apply(reddit, { addSubreddits: ["saas"] })).toMatchObject({ ok: true, applied: { addedSubreddits: 0 } });
    expect((await sql`select objective,min_score from noelle.reddit_watchlist where agent_instance_id=${reddit}`)[0]).toEqual({ objective: "Keep this steer", min_score: 17 });
    expect(await apply(reddit, { removeSubreddits: ["r/SaaS", "not_present"] })).toMatchObject({ ok: true, applied: { removedSubreddits: 1 } });
    expect((await sql`select agent_instance_id from noelle.reddit_watchlist`)[0]?.agent_instance_id).toBe(foreign);
  });
  it.each([[reddit, { addHandles: ["example"] }], [x, { addPeople: ["example"] }], [linkedin, { addKeywords: ["example"] }], [ceo, { addHandles: ["example"] }], [reddit, { mission: "Must not change", addPeople: ["example"] }]])("rejects wrong-role fields before any write for %s", async (instanceId, proposal) => {
    expect(await apply(instanceId, proposal)).toMatchObject({ ok: false, error: "invalid" });
    expect(await counts()).toEqual({ x: 0, linkedin: 0, reddit: 0 });
    expect((await sql`select objective from noelle.agent_instances where id=${instanceId}`)[0]?.objective).toBeNull();
  });
  it("refuses a foreign instance without writes", async () => {
    expect(await apply(foreign, { addSubreddits: ["saas"] })).toMatchObject({ ok: false, error: "not_found" });
    expect(await counts()).toEqual({ x: 0, linkedin: 0, reddit: 0 });
  });
  it.each(["role", "org"] as const)("rechecks the committed %s binding in the write transaction", async (kind) => {
    fixture.beforeWrite = async () => { if (kind === "role") await sql`update noelle.agent_instances set role='video_intern' where id=${x}`; else await sql`update noelle.agent_instances set org_id=${foreignOrg} where id=${x}`; };
    expect(await apply(x, { mission: "Must not change", addHandles: ["example"] })).toMatchObject({ ok: false, error: kind === "role" ? "invalid" : "not_found" });
    expect(await counts()).toEqual({ x: 0, linkedin: 0, reddit: 0 });
    expect((await sql`select objective from noelle.agent_instances where id=${x}`)[0]?.objective).toBeNull();
  });
  it("concurrent deduplicated additions report one committed row", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => apply(reddit, { addSubreddits: ["r/SaaS", "saas"] })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.reduce((total, result) => total + ((result.applied as Record<string, number> | undefined)?.addedSubreddits ?? 0), 0)).toBe(1);
    expect(await counts()).toEqual({ x: 0, linkedin: 0, reddit: 1 });
  });
  it.each([[x, { addHandles: ["@Example"] }, "addedHandles"], [linkedin, { addPeople: ["https://linkedin.com/in/example/"] }, "addedPeople"]])("existing %s role additions count inserted rows rather than requested rows", async (instanceId, proposal, key) => {
    expect(await apply(instanceId, proposal)).toMatchObject({ ok: true, applied: { [key]: 1 } });
    expect(await apply(instanceId, proposal)).toMatchObject({ ok: true, applied: { [key]: 0 } });
  });
  it("an unchanged mission is acknowledged without claiming an update", async () => {
    await sql`update noelle.agent_instances set objective='Meet founders' where id=${x}`;
    expect(await apply(x, { mission: "Meet founders" })).toMatchObject({ ok: true, applied: { missionChanged: false } });
  });
  it.each(["x", "linkedin", "reddit"] as const)("refuses a contradictory foreign-org %s target instead of acknowledging it", async (platform) => {
    const instanceId = platform === "x" ? x : platform === "linkedin" ? linkedin : reddit;
    if (platform === "x") await sql`insert into noelle.x_watchlist(org_id,agent_instance_id,kind,value) values (${foreignOrg},${instanceId},'handle','example')`;
    else if (platform === "linkedin") await sql`insert into noelle.linkedin_watchlist_people(org_id,agent_instance_id,fsd_profile_id,public_id) values (${foreignOrg},${instanceId},'example','example')`;
    else await sql`insert into noelle.reddit_watchlist(org_id,agent_instance_id,subreddit) values (${foreignOrg},${instanceId},'example')`;
    const proposal = { mission: "Must not change", ...(platform === "x" ? { addHandles: ["example"] } : platform === "linkedin" ? { addPeople: ["example"] } : { addSubreddits: ["example"] }) };
    expect(await apply(instanceId, proposal)).toMatchObject({ ok: false, error: "not_found" });
    expect((await sql`select objective from noelle.agent_instances where id=${instanceId}`)[0]?.objective).toBeNull();
  });
  it("deduplicates a LinkedIn public slug after its stable profile ID was resolved", async () => {
    await sql`insert into noelle.linkedin_watchlist_people(org_id,agent_instance_id,fsd_profile_id,public_id) values (${org},${linkedin},'resolved-profile-id','example')`;
    expect(await apply(linkedin, { addPeople: ["example"] })).toMatchObject({ ok: true, applied: { addedPeople: 0 } });
    expect(await counts()).toEqual({ x: 0, linkedin: 1, reddit: 0 });
  });
});

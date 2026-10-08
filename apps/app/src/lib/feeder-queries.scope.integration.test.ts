import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock("@/lib/db", () => ({
  readSql: (...args: unknown[]) => Reflect.apply(fixture.sql, undefined, args),
  sql: (...args: unknown[]) => Reflect.apply(fixture.sql, undefined, args),
}));
vi.mock("@/lib/queries", async () => {
  const { assertOrgMember } = await import("@noelle/runtime");
  return {
    async getAgentInstance(id: string) {
      const [inst] = await fixture.sql`select * from noelle.agent_instances where id=${id}`;
      if (!inst) return null;
      await assertOrgMember(
        async (query, parameters) => fixture.sql.unsafe(query, parameters as never[]),
        "00000000-0000-4000-8000-000000000099",
        inst.org_id as string,
      );
      return inst;
    },
  };
});
import { listFeederSourceProfiles, getFeederRunStatus } from "./feeder-queries";
const url = process.env.NOELLE_CONTENT_SCOPE_TEST_DATABASE_URL;
describe.skipIf(!url)("feeder view scope (dedicated PostgreSQL)", () => {
  const ownOrg = "00000000-0000-4000-8000-000000000001",
    otherOrg = "00000000-0000-4000-8000-000000000002";
  const ownX = "00000000-0000-4000-8000-000000000011",
    otherX = "00000000-0000-4000-8000-000000000012";
  const ownLi = "00000000-0000-4000-8000-000000000021",
    otherLi = "00000000-0000-4000-8000-000000000022";
  const user = "00000000-0000-4000-8000-000000000099";
  let sql: Sql;
  async function styledDraft(
    owner: string,
    platform = "linkedin",
    org = ownOrg,
    blend: postgres.JSONValue = [{ handle: "voice", weight: 0.75 }],
  ) {
    const [lead] =
      await sql`insert into noelle.leads(external_id,org_id,agent_instance_id,platform,payload) values (${randomUUID()},${org},${owner},${platform},'{}') returning id`;
    const [draft] =
      await sql`insert into noelle.drafts(lead_id,org_id,payload) values (${lead!.id},${org},${sql.json({ body: "A real reply fixture", style_source: { blend } })}) returning id`;
    await sql`insert into noelle.approvals(org_id,agent_instance_id,lead_id,draft_id) values (${org},${owner},${lead!.id},${draft!.id})`;
  }
  async function ownProfile() {
    const [source] = await listFeederSourceProfiles(ownLi);
    expect(source).toBeDefined();
    return source!;
  }

  beforeAll(async () => {
    const blocked = () => {
      throw new Error("Network is forbidden in content scope fixtures");
    };
    vi.stubGlobal("fetch", blocked);
    vi.spyOn(http, "request").mockImplementation(blocked);
    vi.spyOn(http, "get").mockImplementation(blocked);
    vi.spyOn(https, "request").mockImplementation(blocked);
    vi.spyOn(https, "get").mockImplementation(blocked);
    const url = process.env.NOELLE_CONTENT_SCOPE_TEST_DATABASE_URL;
    if (
      !url ||
      new URL(url).pathname !== "/noelle_content_scope_test" ||
      !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
    )
      throw new Error("Exact dedicated local database required");
    sql = fixture.sql = postgres(url, {
      max: 3,
      onnotice: () => {},
      connection: {
        application_name: "content_scope_actual_entry_fixture",
        statement_timeout: 5000,
      },
    });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_content_scope_test")
      throw new Error("Exact database required before DDL");
    await sql`drop schema if exists noelle cascade`;
    for (const name of [
      "0001_noelle_schema.sql",
      "0005_leads_full_schema.sql",
      "0018_x_watchlist_people.sql",
      "0023_persons_crm.sql",
      "0051_account_feeder.sql",
      "0078_worker_run_summary.sql",
    ])
      await sql.unsafe(
        await readFile(
          new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url),
          "utf8",
        ),
      );
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    await sql`truncate noelle.worker_runs`;
    await sql`insert into noelle.organizations(id,slug,name) values (${ownOrg},'selected','Selected'),(${otherOrg},'other','Other')`;
    await sql`insert into noelle.agent_instances(id,org_id,role,status) values
    (${ownX},${ownOrg},'x_intern','paused'),(${otherX},${otherOrg},'x_intern','active'),
    (${ownLi},${ownOrg},'linkedin_intern','paused'),(${otherLi},${otherOrg},'linkedin_intern','active')`;
    await sql`insert into noelle.org_members(org_id,user_id) values (${ownOrg},${user}),(${otherOrg},${user})`;
    await sql`insert into noelle.account_feeder_sources(org_id,agent_instance_id,platform,handle) values (${ownOrg},${ownLi},'linkedin','voice')`;
  });
  afterAll(async () => {
    await sql?.end({ timeout: 0 });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("healthy own instance and platform style attribution", async () => {
    await styledDraft(ownLi);
    expect(await ownProfile()).toMatchObject({
      draftsUsed: 1,
      totalStyledDrafts: 1,
      avgWeight: 0.75,
    });
  });
  test("style attribution excludes another role instance in the same org", async () => {
    await styledDraft(ownX, "x");
    expect(await ownProfile()).toMatchObject({
      draftsUsed: 0,
      totalStyledDrafts: 0,
      avgWeight: null,
    });
  });
  test("style attribution excludes different-platform drafts on the same instance", async () => {
    await styledDraft(ownLi, "x");
    expect(await ownProfile()).toMatchObject({
      draftsUsed: 0,
      totalStyledDrafts: 0,
      avgWeight: null,
    });
  });
  test("healthy foreign org draft is excluded from style attribution", async () => {
    await styledDraft(otherLi, "linkedin", otherOrg);
    expect(await ownProfile()).toMatchObject({
      draftsUsed: 0,
      totalStyledDrafts: 0,
      avgWeight: null,
    });
  });
  test("source corpus count excludes contradictory org soft reference", async () => {
    await sql`insert into noelle.account_style_posts(org_id,agent_instance_id,platform,account_handle,external_id,body) values (${otherOrg},${ownLi},'linkedin','voice','foreign-corpus','Foreign source')`;
    expect(await ownProfile()).toMatchObject({ postCount: 0 });
  });
  test("malformed unrelated blend object does not break whole instance profile read", async () => {
    await styledDraft(ownX, "x", ownOrg, { handle: "voice", weight: 0.5 });
    await expect(ownProfile()).resolves.toMatchObject({ draftsUsed: 0 });
  });
  test("heartbeat from another instance cannot override own requested state", async () => {
    await sql`update noelle.agent_instances set account_feeder_run_requested_at=now() where id=${ownLi}`;
    await sql`insert into noelle.worker_runs(worker,instance_id) values ('linkedin_feeder',${otherLi})`;
    expect(await getFeederRunStatus(ownLi)).toMatchObject({
      state: "requested",
      lastStartedAt: null,
    });
  });
  test("heartbeat error from another instance cannot mark own idle instance errored", async () => {
    await sql`insert into noelle.worker_runs(worker,instance_id,finished_at,error) values ('linkedin_feeder',${otherLi},now(),'foreign failure')`;
    expect(await getFeederRunStatus(ownLi)).toMatchObject({ state: "idle", lastError: null });
  });
  test("healthy own heartbeat shows running", async () => {
    await sql`insert into noelle.worker_runs(worker,instance_id) values ('linkedin_feeder',${ownLi})`;
    expect(await getFeederRunStatus(ownLi)).toMatchObject({ state: "running" });
  });
  test("healthy requested flag with no heartbeat", async () => {
    await sql`update noelle.agent_instances set account_feeder_run_requested_at=now() where id=${ownLi}`;
    expect(await getFeederRunStatus(ownLi)).toMatchObject({
      state: "requested",
      lastStartedAt: null,
    });
  });
  test("zero style weight is measured and disabled sources remain visible", async () => {
    await sql`update noelle.account_feeder_sources set enabled=false`;
    await styledDraft(ownLi, "linkedin", ownOrg, [{ handle: "voice", weight: 0 }]);
    expect(await ownProfile()).toMatchObject({
      enabled: false,
      draftsUsed: 1,
      totalStyledDrafts: 1,
      avgWeight: 0,
    });
  });
  test.each([null, "wrong", {}, []])(
    "non-numeric stored weight %j does not abort attribution",
    async (weight) => {
      await styledDraft(ownLi, "linkedin", ownOrg, [{ handle: "voice", weight }]);
      expect(await ownProfile()).toMatchObject({
        draftsUsed: 1,
        totalStyledDrafts: 1,
        avgWeight: null,
      });
    },
  );
  test("legacy unassigned lead remains coherent for the selected approval instance", async () => {
    await styledDraft(ownLi);

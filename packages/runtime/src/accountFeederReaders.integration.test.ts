import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listEnabledFeederSources, listFeederSources, listUltraProfiles, getUltraProfileForHandle } from "./accountFeederDb.js";

const url = process.env.NOELLE_FEEDER_READERS_TEST_DATABASE_URL;
describe.skipIf(!url)("account feeder reader ownership (native PostgreSQL)", () => {
  let sql: Sql;
  let orgId: string;
  let otherOrgId: string;
  let instanceId: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    if (!String((await sql`select current_database() as name`)[0]?.name).includes("account_feeder_readers_test")) throw new Error("dedicated feeder readers test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0051_account_feeder.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    orgId = String((await sql`insert into noelle.organizations(slug,name) values ('reader_main','Reader main') returning id`)[0]!.id);
    otherOrgId = String((await sql`insert into noelle.organizations(slug,name) values ('reader_other','Reader other') returning id`)[0]!.id);
    instanceId = String((await sql`insert into noelle.agent_instances(org_id,role) values (${orgId},'x_intern') returning id`)[0]!.id);
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  const source = (handle: string, over: { org?: string; enabled?: boolean; platform?: string } = {}) => sql`
    insert into noelle.account_feeder_sources(org_id,agent_instance_id,platform,handle,enabled)
    values (${over.org ?? orgId},${instanceId},${over.platform ?? "x"},${handle},${over.enabled ?? true})`;
  const profile = (handle: string, org = orgId) => sql`
    insert into noelle.account_ultra_profiles(org_id,agent_instance_id,platform,account_handle,voice_summary)
    values (${org},${instanceId},'x',${handle},'Saved fixture style')`;
  const args = () => ({ agentInstanceId: instanceId, platform: "x" });

  it("reads only coherent enabled sources and preserves cross-platform source eligibility", async () => {
    await source("first");
    await source("foreign", { org: otherOrgId });
    await source("disabled", { enabled: false });
    await source("linkedin_source", { platform: "linkedin" });
    expect((await listEnabledFeederSources(sql, instanceId)).map(row => row.handle)).toEqual(["first", "linkedin_source"]);
  });
  it("preserves disabled picker sources while enforcing platform and current org", async () => {
    await source("enabled");
    await source("foreign", { org: otherOrgId });
    await source("pinned", { enabled: false });
    await source("other_platform", { platform: "linkedin" });
    expect((await listFeederSources(sql, args())).map(row => row.handle)).toEqual(["enabled", "pinned"]);
  });
  it("automatic profiles require coherent profile and enabled source with matching platform and handle", async () => {
    await source("VALID"); await profile("valid");
    await source("foreign_profile"); await profile("foreign_profile", otherOrgId);
    await source("foreign_source", { org: otherOrgId }); await profile("foreign_source");
    await source("disabled", { enabled: false }); await profile("disabled");
    await source("wrong_platform", { platform: "linkedin" }); await profile("wrong_platform");
    await sql`update noelle.account_ultra_profiles set hook_patterns='[1,"hook"]'::jsonb,
      signature_phrases='"not-a-list"'::jsonb where account_handle='valid'`;
    expect(await listUltraProfiles(sql, args())).toEqual([expect.objectContaining({ account_handle: "valid",
      hook_patterns: ["hook"], signature_phrases: [], top_topics: [] })]);
  });
  it("pinned profile remains case-insensitive and enabled-independent but excludes foreign ownership", async () => {
    await source("pinned", { enabled: false }); await profile("pinned");
    await profile("foreign", otherOrgId);
    expect((await getUltraProfileForHandle(sql, { ...args(), handle: "PINNED" }))?.account_handle).toBe("pinned");
    expect(await getUltraProfileForHandle(sql, { ...args(), handle: "foreign" })).toBeNull();
    expect(await getUltraProfileForHandle(sql, { ...args(), handle: "missing" })).toBeNull();
  });
  it("excludes stale saved sources and profiles after the current parent changes org", async () => {
    await source("saved"); await profile("saved");
    await sql`update noelle.agent_instances set org_id=${otherOrgId} where id=${instanceId}`;
    expect(await listEnabledFeederSources(sql, instanceId)).toEqual([]);
    expect(await listFeederSources(sql, args())).toEqual([]);
    expect(await listUltraProfiles(sql, args())).toEqual([]);
    expect(await getUltraProfileForHandle(sql, { ...args(), handle: "saved" })).toBeNull();
  });
});

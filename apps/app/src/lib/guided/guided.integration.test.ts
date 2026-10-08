import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
const fixture = vi.hoisted(() => ({ sql: undefined as unknown as Sql, writes: vi.fn() }));
vi.mock("@/lib/db", () => ({
  sql: Object.assign((...args: unknown[]) => Reflect.apply(fixture.sql, undefined, args), {
    json: (value: postgres.JSONValue) => fixture.sql.json(value),
    unsafe: (text: string, parameters: never[]) => fixture.sql.unsafe(text, parameters),
  }),
  pgOrgMembersClient: () => async (text: string, parameters: never[]) => fixture.sql.unsafe(text, parameters),
  withTx: (operation: (tx: postgres.TransactionSql) => Promise<unknown>) => fixture.sql.begin(operation),
}));
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => ({ id: "00000000-0000-4000-8000-000000000099" }) }));
vi.mock("@/lib/queries", async () => {
  const { assertOrgMember } = await import("@noelle/runtime");
  return { async getOrgBySlug(slug: string) {
    const [row] = await fixture.sql`select * from noelle.organizations where slug=${slug}`;
    if (!row) return null;
    await assertOrgMember(async (text, parameters) => fixture.sql.unsafe(text, parameters as never[]), "00000000-0000-4000-8000-000000000099", row.org_id ?? row.id);
    return row;
  } };
});
vi.mock("@noelle/runtime/vault-storage", () => ({
  createGcsStorage: async () => ({}), createVaultStorage: () => ({ writeText: fixture.writes }),
}));
import { loadGuidedSignals } from "./signals";
import { submitVaultStage } from "@/app/app/[orgSlug]/onboarding/vault/actions";
const schema = resolve(__dirname, "../../../../../infra/cloudsql/schema");
const url = process.env.NOELLE_GUIDED_TEST_DATABASE_URL;
const own = "aaa00000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002", user = "00000000-0000-4000-8000-000000000099";
const ids = { x_intern: "00000000-0000-4000-8000-000000000011", linkedin_intern: "00000000-0000-4000-8000-000000000021", reddit_intern: "00000000-0000-4000-8000-000000000031", video_intern: "00000000-0000-4000-8000-000000000041" };
const foreignX = "00000000-0000-4000-8000-000000000012";
describe.skipIf(!url)("guided actual PostgreSQL entries", () => {
let sql: Sql;
beforeAll(async () => {
  const blocked = () => { throw new Error("HTTP provider traffic forbidden in guided native fixture"); };
  vi.stubGlobal("fetch", blocked);
  for (const network of [http, https]) for (const method of ["request", "get"] as const) vi.spyOn(network, method).mockImplementation(blocked);
  if (!url || new URL(url).pathname !== "/noelle_guided_setup_test" || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Exact dedicated local database required");
  sql = fixture.sql = postgres(url, { max: 3, onnotice: () => {}, connection: { application_name: "guided_actual_entry_fixture", statement_timeout: 5000 } });
  if ((await sql`select current_database() as name`)[0]?.name !== "noelle_guided_setup_test") throw new Error("Wrong database before DDL");
  await sql`drop schema if exists noelle cascade`;
  for (const name of ["0001_noelle_schema.sql", "0004_drafts_sent_at.sql", "0003_x_watchlist.sql", "0005_leads_full_schema.sql", "0006_vaults.sql", "0008_vault_wizard.sql", "0018_x_watchlist_people.sql", "0027_linkedin_watchlist_people.sql", "0037_linkedin_watchlist.sql", "0054_reddit_watchlist.sql", "0065_video_intern_watchlist.sql", "0081_reply_send_enabled.sql", "0033_connections_credentials.sql", "0040_connections_multi_token.sql", "0041_connections_token_retry.sql", "0058_connections_in_use.sql"])
    await sql.unsafe(await readFile(resolve(schema, name), "utf8"));
});
beforeEach(async () => {
  await sql`drop trigger if exists reject_guided_stage on noelle.vaults`;
  await sql`truncate noelle.organizations cascade`;
  await sql`insert into noelle.organizations(id,slug,name) values (${own},'selected','Selected'),(${other},'other','Other')`;
  await sql`insert into noelle.org_members(org_id,user_id) values (${own},${user}),(${other},${user})`;
  for (const [role, id] of Object.entries(ids)) await sql`insert into noelle.agent_instances(id,org_id,role,status) values (${id},${own},${role},'active')`;
  await sql`insert into noelle.agent_instances(id,org_id,role,status) values (${foreignX},${other},'x_intern','active')`;
  fixture.writes.mockReset().mockResolvedValue(undefined);
});
afterAll(async () => { await sql?.end({ timeout: 0 }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const load = () => loadGuidedSignals({ orgId: own, pendingApprovals: 0, xPostingReady: false });
async function approval(status: string, decidedBy: string | null = null, owner = ids.x_intern) {
  const [lead] = await sql`insert into noelle.leads(external_id,org_id,agent_instance_id,payload) values (${randomUUID()},${own},${ids.x_intern},'{}') returning id`;
  const [draft] = await sql`insert into noelle.drafts(lead_id,org_id,payload) values (${lead!.id},${own},'{}') returning id`;
  const [row] = await sql`insert into noelle.approvals(org_id,agent_instance_id,lead_id,draft_id,status,decided_by) values (${own},${owner},${lead!.id},${draft!.id},${status},${decidedBy}) returning id`;
  return { leadId: lead!.id, draftId: draft!.id, approvalId: row!.id };
}
test.each(["expired", "failed"])("system %s approval does not complete an operator review", async status => { await approval(status); expect((await load()).actionedAny).toBe(false); });
test("pending approval is not an operator decision", async () => { await approval("pending"); expect((await load()).actionedAny).toBe(false); });
test.each(["approved", "sent", "skipped"])("healthy human %s decision completes review", async status => { await approval(status, user); expect((await load()).actionedAny).toBe(true); });
test("system auto-send is not presented as a human decision", async () => { await approval("sent", "auto-send"); expect((await load()).actionedAny).toBe(false); });
const targets = ["x-search", "x-person", "li-search", "li-person", "reddit", "video-source", "video-niche"] as const;
async function target(kind: (typeof targets)[number], org: string) {
  if (kind === "x-search") await sql`insert into noelle.x_watchlist(org_id,agent_instance_id,kind,value) values (${org},${ids.x_intern},'keyword','synthetic target')`;
  if (kind === "x-person") await sql`insert into noelle.x_watchlist_people(org_id,agent_instance_id,handle) values (${org},${ids.x_intern},'synthetic')`;
  if (kind === "li-search") await sql`insert into noelle.linkedin_watchlist(org_id,agent_instance_id,kind,value) values (${org},${ids.linkedin_intern},'keyword','synthetic target')`;
  if (kind === "li-person") await sql`insert into noelle.linkedin_watchlist_people(org_id,agent_instance_id,fsd_profile_id) values (${org},${ids.linkedin_intern},'synthetic')`;
  if (kind === "reddit") await sql`insert into noelle.reddit_watchlist(org_id,agent_instance_id,subreddit) values (${org},${ids.reddit_intern},'synthetic')`;
  if (kind === "video-source") await sql`insert into noelle.video_watchlist_sources(org_id,agent_instance_id,handle) values (${org},${ids.video_intern},'synthetic')`;
  if (kind === "video-niche") await sql`insert into noelle.video_watchlist_niches(org_id,agent_instance_id,query) values (${org},${ids.video_intern},'synthetic')`;
}
function role(kind: (typeof targets)[number]): keyof typeof ids {
  if (kind.startsWith("x-")) return "x_intern";
  if (kind.startsWith("li-")) return "linkedin_intern";
  return kind === "reddit" ? "reddit_intern" : "video_intern";
}
test.each(targets)("%s ignores a foreign-org targeting child", async kind => {
  await target(kind, other); expect((await load()).agents.find(a => a.role === role(kind))?.hasTargeting).toBe(false);
});
test.each(targets)("healthy own %s targeting is visible", async kind => {
  await target(kind, own); expect((await load()).agents.find(a => a.role === role(kind))?.hasTargeting).toBe(true);
});
test.each(["video-source", "video-niche"] as const)("disabled %s is not operating targeting", async kind => {
  await target(kind, own);
  if (kind === "video-source") await sql`update noelle.video_watchlist_sources set enabled=false`;
  else await sql`update noelle.video_watchlist_niches set enabled=false`;
  expect((await load()).agents.find(a => a.role === "video_intern")?.hasTargeting).toBe(false);
});
test("source output with a foreign current parent does not prove own pipeline output", async () => {
  await sql`insert into noelle.leads(external_id,org_id,agent_instance_id,payload) values (${randomUUID()},${own},${foreignX},'{}')`;
  expect((await load()).discoveredAny).toBe(false);
});
test("healthy own lead and draft remain visible", async () => {
  await approval("pending"); expect(await load()).toMatchObject({ discoveredAny: true, draftedAny: true, actionedAny: false });
});
test("explicit legacy unassigned own lead remains visible", async () => {
  await sql`insert into noelle.leads(external_id,org_id,agent_instance_id,payload) values (${randomUUID()},${own},null,'{}')`;
  expect((await load()).discoveredAny).toBe(true);
});
test("approval on another organization current parent cannot prove own human review", async () => {
  await approval("sent", user, foreignX); expect((await load()).actionedAny).toBe(false);
});
test("canonical membership guard denies a nonmember", async () => {
  await sql`delete from noelle.org_members where org_id=${own}`;
  await expect(load()).rejects.toMatchObject({ code: "not_org_member" });
});
test.each([
  ["skipped", "automatic-review"], ["sent", own], ["skipped", own],
  ["sent", own.toUpperCase()],
  ["approved", null], ["sent", null], ["skipped", ""],
] as const)("%s/%s does not prove recorded operator review", async (status, by) => {
  await approval(status, by); expect((await load()).actionedAny).toBe(false);
});
test("a human review with a legacy unassigned source remains visible", async () => {
  const row = await approval("sent", user); await sql`update noelle.leads set agent_instance_id=null where id=${row.leadId}`;
  expect((await load()).actionedAny).toBe(true);
});
test.each(["draft-org", "source-org", "source-id"] as const)("contradictory %s cannot prove own review", async kind => {
  const row = await approval("approved", user);
  if (kind === "draft-org") await sql`update noelle.drafts set org_id=${other} where id=${row.draftId}`;
  if (kind === "source-org") await sql`update noelle.leads set org_id=${other} where id=${row.leadId}`;
  if (kind === "source-id") {
    const otherRow = await approval("pending"); await sql`update noelle.approvals set lead_id=${otherRow.leadId} where id=${row.approvalId}`;
  }
  expect((await load()).actionedAny).toBe(false);
});
test("a draft attached to a foreign-org source is not own pipeline output", async () => {
  const row = await approval("pending"); await sql`update noelle.leads set org_id=${other} where id=${row.leadId}`;
  expect((await load()).draftedAny).toBe(false);
});
const light = { personName: "Synthetic voice", oneLineWhat: "Synthetic product", audience: "Synthetic audience" };
test("actual wizard rejects mismatched authorized org id and slug before storage writes", async () => {
  const result = await submitVaultStage({ orgId: own, orgSlug: "other", stage: "light", answers: light });
  expect(result.ok).toBe(false); expect(fixture.writes).not.toHaveBeenCalled();
  expect(await sql`select * from noelle.vaults where org_id=${own}`).toHaveLength(0);
});
test("healthy actual wizard writes only its provisioned own prefix and commits both markers", async () => {
  expect(await submitVaultStage({ orgId: own, orgSlug: "selected", stage: "light", answers: light })).toEqual({ ok: true, nextStep: "medium" });
  expect(fixture.writes).toHaveBeenCalled();
  for (const [argument] of fixture.writes.mock.calls) expect(argument).toMatchObject({ prefix: "selected/" });
  expect((await sql`select wizard_stage from noelle.vaults where org_id=${own}`)[0]?.wizard_stage).toBe("light");
  expect((await sql`select stage_completed from noelle.vault_wizard_answers where org_id=${own}`)[0]?.stage_completed).toBe("light");
});
test("faulted final stage update does not leave answers committed without that stage", async () => {
  await sql.unsafe(`create or replace function noelle.reject_guided_stage_fixture() returns trigger language plpgsql as $$ begin raise exception 'inert final stage write failure'; end $$`);
  await sql.unsafe(`create trigger reject_guided_stage before update of wizard_stage on noelle.vaults for each row execute function noelle.reject_guided_stage_fixture()`);
  await expect(submitVaultStage({ orgId: own, orgSlug: "selected", stage: "light", answers: light })).rejects.toThrow("inert final stage write failure");
  expect(await sql`select * from noelle.vault_wizard_answers where org_id=${own}`).toHaveLength(0);
});

});

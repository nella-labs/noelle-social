import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { NoelleAgentInstance } from "@/lib/db-types";

const fixture = vi.hoisted(() => ({ sql: null as unknown as Sql }));
vi.mock("@/lib/db", () => ({ sql: new Proxy(function () {}, {
  apply: (_target, receiver, args) => Reflect.apply(fixture.sql, receiver, args),
  get: (_target, property) => { const value = Reflect.get(fixture.sql, property); return typeof value === "function" ? value.bind(fixture.sql) : value; },
}) }));
import { loadChatContextForInstance } from "./context";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const org = "00000000-0000-4000-8000-000000000001", foreign = "00000000-0000-4000-8000-000000000002";
const ownX = "00000000-0000-4000-8000-000000000011", ownLi = "00000000-0000-4000-8000-000000000012", ownReddit = "00000000-0000-4000-8000-000000000013";
const foreignX = "00000000-0000-4000-8000-000000000021";
const url = process.env.NOELLE_CHAT_CONTEXT_TEST_DATABASE_URL;
describe.skipIf(!url)("actual chat context with native tenant soft references", () => {
  let sql: Sql;
  const instance = (id = ownX, role = "x_intern") => ({ id, role, org_id: org }) as NoelleAgentInstance;
  const context = () => loadChatContextForInstance(instance());
  async function lead(options: { org?: string; instance?: string; platform?: string; body?: string; score?: number } = {}) {
    const id = randomUUID();
    await sql`insert into noelle.leads(id,external_id,org_id,agent_instance_id,platform,status,author_handle,tier,classifier_score,payload)
      values (${id},${id},${options.org ?? org},${options.instance ?? ownX},${options.platform ?? "x"},'classified','source_author','T1',${options.score ?? 80},${sql.json({ text: options.body ?? "Owned source", url: "https://www.reddit.com/r/saas/comments/abc/thread/", subreddit: "saas" })})`;
    return id;
  }
  async function approval(leadId: string, options: { org?: string; draftOrg?: string; draftLead?: string; instance?: string; status?: string; payload?: postgres.JSONValue } = {}) {
    const id = randomUUID(), draftId = randomUUID();
    await sql`insert into noelle.drafts(id,lead_id,org_id,payload) values (${draftId},${options.draftLead ?? leadId},${options.draftOrg ?? org},${sql.json(options.payload ?? { body: "Owned reply", angle: "technical" })})`;
    await sql`insert into noelle.approvals(id,org_id,agent_instance_id,draft_id,lead_id,status)
      values (${id},${options.org ?? org},${options.instance ?? ownX},${draftId},${leadId},${options.status ?? "pending"})`;
    return id;
  }
  beforeAll(async () => {
    sql = postgres(url!, { max: 6, onnotice: () => {}, connection: { application_name: "noelle-chat-context-fixture" } });
    expect((await sql`select current_database() as db`)[0]?.db).toBe("noelle_chat_context_test");
    fixture.sql = sql; await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0004_drafts_sent_at.sql", "0005_leads_full_schema.sql", "0003_x_watchlist.sql", "0017_agent_objective.sql", "0027_linkedin_watchlist_people.sql", "0054_reddit_watchlist.sql"])
      await sql.unsafe(readFileSync(resolve(repo, "infra/cloudsql/schema", name), "utf8"));
  });
  beforeEach(async () => {
    vi.stubEnv("NOELLE_VAULT_DIR", "");
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${org},'fixture','Fixture'),(${foreign},'foreign','Foreign')`;
    await sql`insert into noelle.agent_instances(id,org_id,role) values (${ownX},${org},'x_intern'),(${ownLi},${org},'linkedin_intern'),(${ownReddit},${org},'reddit_intern'),(${foreignX},${foreign},'x_intern')`;
  });
  afterAll(async () => { vi.unstubAllEnvs(); await sql?.end(); });
  test("owned coherent pending rows retain their actual text and counts", async () => {
    const id = await approval(await lead()); const result = await context();
    expect(result.pendingApprovals?.map((row) => row.approvalId)).toEqual([id]);
    expect(result.pendingApprovals?.[0]?.draftBody).toBe("Owned reply"); expect(result.totalPendingCount).toBe(1);
  });
  test.each(["approval", "draft", "lead"] as const)("a foreign %s soft reference is not quoted", async (kind) => {
    const leadId = await lead(kind === "lead" ? { org: foreign } : {});
    await approval(leadId, { org: kind === "approval" ? foreign : org, draftOrg: kind === "draft" ? foreign : org });
    expect((await context()).pendingApprovals).toEqual([]);
  });
  test("approval and draft must agree on the actual lead", async () => {
    await approval(await lead(), { draftLead: await lead({ body: "Unrelated source" }) });
    expect((await context()).pendingApprovals).toEqual([]);
  });
  test("the lead's current instance must agree with the approval owner", async () => {
    await approval(await lead({ instance: ownLi })); expect((await context()).pendingApprovals).toEqual([]);
  });
  test("an instance rebound to another tenant cannot expose old approvals", async () => {
    await approval(await lead()); await sql`delete from noelle.agent_instances where id=${foreignX}`;
    await sql`update noelle.agent_instances set org_id=${foreign} where id=${ownX}`;
    expect((await context()).pendingApprovals).toEqual([]);
  });
  test("foreign approval ownership does not inflate either instance total", async () => {
    await approval(await lead(), { org: foreign }); await approval(await lead(), { org: foreign, status: "sent" });
    const result = await context(); expect(result.totalPendingCount).toBe(0); expect(result.totalSentLifetime).toBe(0);
  });
  test("foreign drafts do not claim an owned lead has a usable draft", async () => {
    const leadId = await lead(); await sql`insert into noelle.drafts(lead_id,org_id,payload) values (${leadId},${foreign},${sql.json({ body: "Foreign reply" })})`;
    expect((await context()).bestLeads?.[0]?.hasDraft).toBe(false);
  });
  test("a foreign pending approval cannot hide a current owned lead", async () => {
    const leadId = await lead(); await approval(leadId, { org: foreign, draftOrg: foreign });
    expect((await context()).bestLeads?.map((row) => row.postId)).toEqual([leadId]);
  });
  test("blank/skip top rows cannot consume the entire bounded queue snapshot", async () => {
    for (let i = 0; i < 5; i++) await approval(await lead({ score: 100 }), { payload: { body: "SKIP: no nella fit" } });
    const id = await approval(await lead({ score: 70 }));
    expect((await context()).pendingApprovals?.map((row) => row.approvalId)).toEqual([id]);
  });
  test("Reddit's real pending thread is available to its profile", async () => {
    const id = await approval(await lead({ instance: ownReddit, platform: "reddit" }), { instance: ownReddit });
    const result = await loadChatContextForInstance(instance(ownReddit, "reddit_intern"));
    expect(result.pendingApprovals?.map((row) => row.approvalId)).toEqual([id]);
  });
  test("a real edited body is authoritative over the stored selected angle", async () => {
    await approval(await lead(), { payload: { body: "Original", edited_body: "Confirmed edit", angle: "technical", angles: { technical: { body: "Old bundle" } } } });
    expect((await context()).pendingApprovals?.[0]?.draftBody).toBe("Confirmed edit");
  });
  test.each(["", " \u00a0\ufeff ", null, 0, false, {}, []])("explicit cleared or non-text edit %j cannot consume a queue slot", async (edited_body) => {
    await approval(await lead(), { payload: { body: "Old", edited_body, angle: "technical", angles: { technical: { body: "Old bundle" } } } });
    expect((await context()).pendingApprovals).toEqual([]);
  });
  test("a valid angle-ambiguous edit stays flat and never gains invented angle provenance", async () => {
    await approval(await lead(), { payload: { edited_body: "Confirmed edit", angles: { empathetic: { body: "Old warm" }, technical: { body: "Old technical" } } } });
    expect((await context()).pendingApprovals?.[0]).toMatchObject({ draftBody: "Confirmed edit", selectedAngle: null });
  });
  test("an unedited legacy bundle keeps its actual selected variant", async () => {
    await approval(await lead(), { payload: { angle: "technical", angles: { empathetic: { body: "Warm" }, technical: { body: "Technical" } } } });
    expect((await context()).pendingApprovals?.[0]).toMatchObject({ draftBody: "Technical", selectedAngle: "technical" });
  });
  test("mixed sent/skipped history retains valid legacy unassigned source rows", async () => {
    const leadId = await lead(); await sql`update noelle.leads set agent_instance_id=null where id=${leadId}`;
    await approval(leadId, { status: "sent" }); await approval(leadId, { status: "skipped" });
    expect((await context()).totalSentLifetime).toBe(2);
  });
  test.each(["linkedin", "reddit"] as const)("%s uses the actual source URL and outbound text without an X composer", async (platform) => {
    const owner = platform === "linkedin" ? ownLi : ownReddit;
    const leadId = await lead({ instance: owner, platform });
    const postUrl = platform === "reddit" ? "https://www.reddit.com/r/saas/comments/abc/thread/" : "https://www.linkedin.com/feed/update/urn:li:activity:123/";
    await sql`update noelle.leads set payload=${sql.json({ original_post_text: "Actual outbound source", original_post_url: postUrl })} where id=${leadId}`;
    await approval(leadId, { instance: owner });
    const result = await loadChatContextForInstance(instance(owner, `${platform}_intern`));
    expect(result.pendingApprovals?.[0]).toMatchObject({ postText: "Actual outbound source", replyUrl: postUrl });
    expect(result.pendingApprovals?.[0]?.replyUrl).not.toContain("x.com");
  });
  test("a Reddit comment reply names only its recorded commenter and opens its comment permalink", async () => {
    const permalink = "https://www.reddit.com/r/saas/comments/abc/thread/comment123/";
    await approval(await lead({ instance: ownReddit, platform: "reddit" }), { instance: ownReddit, payload: { body: "Comment reply", angle: "technical", replyTarget: { kind: "comment", permalink, author: "recorded_commenter" } } });
    const result = await loadChatContextForInstance(instance(ownReddit, "reddit_intern"));
    expect(result.pendingApprovals?.[0]).toMatchObject({ authorHandle: "recorded_commenter", replyUrl: permalink });
  });
});

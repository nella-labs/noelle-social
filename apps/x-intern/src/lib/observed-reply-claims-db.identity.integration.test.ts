import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimObservedLeadsForDrafting } from "./observed-reply-claims-db.js";
import * as opportunity from "./reply-opportunity.js";

const url = process.env.NOELLE_OBSERVED_THREAD_TEST_DATABASE_URL;
const database = "noelle_observed_reply_identity_test";
if (url && new URL(url).pathname !== `/${database}`) throw new Error("Dedicated observed thread database required");

const decodedCases = [
  '{}',
  '{"conversation_id":"0"}',
  '{"conversation_id":"0000","conversationId":"500"}',
  '{"conversation_id":"000500"}',
  '{"conversation_id":" 500 "}',
  '{"conversation_id":"\\u00a0\\u2003\\ufeff500\\u202f"}',
  '{"conversation_id":"\\u200b500"}',
  '{"conversation_id":"1234567890123456789012345"}',
  '{"conversation_id":"12345678901234567890123456","root_post_id":"700"}',
  '{"conversation_id":"invalid","conversationId":"500"}',
  '{"conversation_id":{},"conversationId":"500"}',
  '{"conversation_id":[],"conversationId":"500"}',
  '{"conversation_id":null,"conversationId":"500"}',
  '{"conversation_id":true,"conversationId":"500"}',
  '{"conversation_id":false}',
  '{"conversation":{"root_post_id":"500"}}',
  '{"conversation_id":"600","conversation":{"root_post_id":"500"}}',
  '{"conversation_id":0}',
  '{"conversation_id":-0}',
  '{"conversation_id":-1}',
  '{"conversation_id":0.5,"conversationId":"500"}',
  '{"conversation_id":1}',
  '{"conversation_id":1.0}',
  '{"conversation_id":1.5,"root_post_id":"500"}',
  '{"conversation_id":9007199254740991}',
  '{"conversation_id":9007199254740992,"conversationId":"500"}',
  '{"conversation_id":1.00000000000000000001}',
  '{"conversation_id":9007199254740990.5}',
  '{"conversation_id":9007199254740991.1}',
  '{"conversation_id":0.99999999999999999999}',
  '{"conversation_id":1.99999999999999999999}',
  '{"conversation_id":9007199254740991.5,"conversationId":"500"}',
  '{"conversation_id":1e1000,"conversationId":"500"}',
  '{"conversation_id":1e-1000,"conversationId":"500"}',
  '{"conversation_id":-1e-1000,"conversationId":"500"}',
  '{"conversation_id":1e15}',
  '{"conversation_id":"1e15","conversationId":"500"}',
];

describe.skipIf(!url)("observed reply SQL thread identity (actual schema)", () => {
  let sql: Sql;
  let orgId: string;
  let instanceId: string;
  let next: number;
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    expect((await sql`select current_database() as name`)[0]?.name).toBe(database);
    await sql`drop schema if exists noelle cascade`;
    for (const migration of ["0001_noelle_schema.sql", "0004_drafts_sent_at.sql", "0003_x_watchlist.sql",
      "0005_leads_full_schema.sql", "0018_x_watchlist_people.sql", "0083_x_activity.sql", "0108_x_browser_discovery.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${migration}`, import.meta.url), "utf8"));
    }
  }, 30_000);
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    const [org] = await sql`insert into noelle.organizations(slug,name) values ('thread_scope','Thread scope') returning id`;
    orgId = String(org!.id);
    const [instance] = await sql`insert into noelle.agent_instances(org_id,role) values (${orgId},'x_intern') returning id`;
    instanceId = String(instance!.id); next = 0;
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  const lead = async (thread: Record<string, unknown>, status = "classified") => {
    const n = ++next;
    const [saved] = await sql`insert into noelle.leads(org_id,agent_instance_id,platform,status,author_handle,external_id,classifier_score,payload)
      values (${orgId},${instanceId},'x',${status},${`author${n}`},${String(100 + n)},0.9,
        ${sql.json({ source: "extension_observed", classifier: { judge: "jev" },
          posted_at: new Date().toISOString(), likeCount: 0, replyCount: 0, ...thread })}) returning id`;
    return String(saved!.id);
  };
  const reviewed = async (thread: Record<string, unknown>, status = "pending") => {
    const id = await lead(thread, "drafted");
    const [draft] = await sql`insert into noelle.drafts(org_id,lead_id,payload,sent_at)
      values (${orgId},${id},'{"kind":"reply","verifier_meta":{"pass":true,"judgeOk":true}}',
        ${status === "sent" ? new Date() : null}) returning id`;
    await sql`insert into noelle.approvals(org_id,agent_instance_id,lead_id,draft_id,status,decided_at)
      values (${orgId},${instanceId},${id},${draft!.id},${status},${status === "sent" ? new Date() : null})`;
    return id;
  };
  const claim = () => claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 2 });

  it("does not let a pending unknown all-zero thread suppress another author", async () => {
    await reviewed({ conversation_id: "0" });
    const wanted = await lead({ conversation_id: "0" });
    expect((await claim()).map(row => row.id)).toEqual([wanted]);
  });
  it.each(["0", "invalid", {}])("blocks a known sent thread behind malformed primary %j", async primary => {
    await reviewed({ conversation_id: primary, conversationId: "500" }, "sent");
    await lead({ conversation_id: "500" });
    expect(await claim()).toEqual([]);
  });
  it("matches a saved sent thread whose valid identity contains surrounding spaces", async () => {
    await reviewed({ conversation_id: " 500 " }, "sent");
    await lead({ conversation_id: "500" });
    expect(await claim()).toEqual([]);
  });
  it("preserves a confirmed pending real-thread exclusion", async () => {
    await reviewed({ conversation_id: "500" });
    await lead({ conversation_id: "500" });
    expect(await claim()).toEqual([]);
  });
  it("preserves a confirmed sent alias exclusion", async () => {
    await reviewed({ conversationId: "500" }, "sent");
    await lead({ conversation_id: "500" });
    expect(await claim()).toEqual([]);
  });
  it("keeps two unknown saved threads from unrelated authors independently claimable", async () => {
    const first = await lead({ conversation_id: "0" });
    const second = await lead({ conversation_id: "0" });
    expect((await claim()).map(row => row.id).sort()).toEqual([first, second].sort());
  });
  it.each(["1.00000000000000000001", "9007199254740990.5"])(
    "matches a sent JSON numeric literal %s after JavaScript decoding", async literal => {
      const sent = await reviewed({}, "sent");
      const raw = `{"conversation_id":${literal}}`;
      await sql`update noelle.leads set payload = payload || ${raw}::text::jsonb where id = ${sent}`;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const [saved] = await sql`select payload, jsonb_typeof(payload->'conversation_id') as type
        from noelle.leads where id = ${sent}`;
      expect(saved?.type).toBe("number");
      expect(saved?.payload.conversation_id).toBe(parsed.conversation_id);
      await lead({ conversation_id: opportunity.replyConversationId(parsed) });
      expect(await claim()).toEqual([]);
    },
  );
  it.each(decodedCases)("matches the public parser after decoding raw JSON %s", async raw => {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const [result] = await sql<{ id: string | null }[]>`
      select ${opportunity.replyConversationIdSql(sql, sql`${raw}::text::jsonb`)} as id
    `;
    expect(result?.id).toBe(opportunity.replyConversationId(parsed));
  });
});

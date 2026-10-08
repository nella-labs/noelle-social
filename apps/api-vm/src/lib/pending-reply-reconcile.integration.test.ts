import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { postgresPendingReplyReconcileStore } from "./pending-reply-reconcile-store.js";
import { reconcilePendingReplyBacklog } from "./pending-reply-reconcile.js";

const url = process.env.NOELLE_REPLY_RECONCILE_TEST_DATABASE_URL;
const org = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000011";

describe.skipIf(!url)("reply reconciliation (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 6, onnotice: () => {} });
    const [database] = await sql`select current_database() as name`;
    if (!database?.name.endsWith("_reply_reconcile_test")) throw new Error("Dedicated test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0004_drafts_sent_at.sql", "0003_x_watchlist.sql", "0005_leads_full_schema.sql", "0018_x_watchlist_people.sql", "0107_linkedin_reply_claims.sql", "0108_x_browser_discovery.sql"])
      await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.x_reply_claims, noelle.linkedin_reply_claims, noelle.approvals, noelle.drafts, noelle.leads, noelle.agent_instances, noelle.organizations cascade`;
    await sql`insert into noelle.organizations (id,slug,name) values (${org},'one','One')`;
    await sql`insert into noelle.agent_instances (id,org_id,role) values (${instance},${org},'x_intern')`;
  });
  afterAll(async () => { await sql?.end(); });

  async function candidate(platform = "x") {
    let owner = instance;
    if (platform === "linkedin") {
      const [row] = await sql<{ id: string }[]>`insert into noelle.agent_instances (org_id,role)
        values (${org},'linkedin_intern') returning id`;
      owner = row!.id;
    }
    const [lead] = await sql`insert into noelle.leads (org_id,agent_instance_id,external_id,platform,payload)
      values (${org},${owner},'101',${platform},'{"text":"original source","posted_at":"2026-09-20T19:00:00Z"}') returning id`;
    const [draft] = await sql`insert into noelle.drafts (org_id,lead_id,payload)
      values (${org},${lead!.id},'{"kind":"reply","body":"original body","verifier_meta":{"pass":false,"judgeOk":true}}') returning id`;
    await sql`insert into noelle.approvals (org_id,agent_instance_id,lead_id,draft_id,status)
      values (${org},${owner},${lead!.id},${draft!.id},'pending')`;
    return (await postgresPendingReplyReconcileStore(sql).list(org))[0]!;
  }
  async function status(approvalId: string) {
    return (await sql`select status from noelle.approvals where id=${approvalId}`)[0]?.status;
  }
  it("disposes an unchanged unreserved pending reply exactly once", async () => {
    const row = await candidate();
    const store = postgresPendingReplyReconcileStore(sql);
    expect(await store.skip(row,"automatic-review-failed",new Date().toISOString())).toBe(true);
    expect(await store.skip(row,"automatic-review-failed",new Date().toISOString())).toBe(false);
    expect(await status(row.approvalId)).toBe("skipped");
  });
  it("pages a shared microsecond timestamp without losing cross-page siblings", async () => {
    const first = await candidate();
    await sql`update noelle.drafts set payload='{ "kind":"reply", "body":"reviewed", "verifier_meta":{"pass":true,"judgeOk":true} }'`;
    await sql`with more as (
      insert into noelle.drafts (org_id,lead_id,payload)
      select ${org}::uuid,${first.leadId}::uuid,'{"kind":"reply","body":"reviewed","verifier_meta":{"pass":true,"judgeOk":true}}'::jsonb from generate_series(1,200)
      returning id,lead_id
    ) insert into noelle.approvals (org_id,agent_instance_id,lead_id,draft_id,status)
      select ${org}::uuid,${instance}::uuid,lead_id,id,'pending' from more`;
    await sql`update noelle.approvals set created_at='2026-09-20T19:00:00.123456Z'`;
    const store = postgresPendingReplyReconcileStore(sql);
    expect(await store.list(org)).toHaveLength(200);
    const counts = await reconcilePendingReplyBacklog({ orgId:org,store,apply:true,policy:{
      linkedinVoiceFloor:0.7,xMaxAgeHours:25,notificationMaxAgeHours:12,now:new Date('2026-09-20T20:00:00Z'),
    } });
    expect(counts).toMatchObject({ selected:201,kept:1,skipped:200,stale:0 });
    expect(await store.list(org)).toHaveLength(1);
  });
  it.each(["review", "body", "source", "target"])("rejects a stale disposition after %s changes", async field => {
    const row = await candidate();
    if (field === "review") await sql`update noelle.drafts set payload=payload||'{"verifier_meta":{"pass":true,"judgeOk":true}}' where id=${row.draftId}`;
    if (field === "body") await sql`update noelle.drafts set payload=payload||'{"edited_body":"new body"}' where id=${row.draftId}`;
    if (field === "source") await sql`update noelle.leads set payload=payload||'{"text":"corrected source"}' where id=${row.leadId}`;
    if (field === "target") await sql`update noelle.leads set external_id='102' where id=${row.leadId}`;
    expect(await postgresPendingReplyReconcileStore(sql).skip(row,"automatic-review-failed",new Date().toISOString())).toBe(false);
    expect(await status(row.approvalId)).toBe("pending");
  });
  it.each(["x", "linkedin"])("keeps permanently reserved %s replies out of disposition", async platform => {
    const row = await candidate(platform);
    if (platform === "x") await sql`insert into noelle.x_reply_claims (org_id,tweet_id,approval_id) values (${org},'101',${row.approvalId})`;
    else await sql`insert into noelle.linkedin_reply_claims (org_id,activity_urn,approval_id) values (${org},'urn:li:activity:101',${row.approvalId})`;
    expect(await postgresPendingReplyReconcileStore(sql).skip(row,"automatic-review-failed",new Date().toISOString())).toBe(false);
    expect(await postgresPendingReplyReconcileStore(sql).list(org)).toEqual([]);
    expect(await status(row.approvalId)).toBe("pending");
  });
  it("waits for a committing review edit before deciding", async () => {
    const row = await candidate();
    let unlock!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const edit = sql.begin(async tx => {
      await tx`update noelle.drafts set payload=payload||'{"verifier_meta":{"pass":true,"judgeOk":true}}' where id=${row.draftId}`;
      locked(); await gate;
    });
    await ready;
    let settled = false;
    const skipped = postgresPendingReplyReconcileStore(sql).skip(row,"automatic-review-failed",new Date().toISOString()).then(value => { settled = true; return value; });
    try {
      let blocked = false;
      for (let i=0;i<100;i++) {
        const [wait] = await sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock') as blocked`;
        blocked = wait?.blocked === true;
        if (blocked || settled) break;
        await new Promise(resolve => setTimeout(resolve,10));
      }
      expect(settled).toBe(false);
      expect(blocked).toBe(true);
    } finally { unlock(); await edit; }
    expect(await skipped).toBe(false);
    expect(await status(row.approvalId)).toBe("pending");
  });
});

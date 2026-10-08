import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PendingReplyCandidate, ReplyReviewMeta, ReplyRecheckMarker } from "./pending-reply-recheck.js";
import { postgresPendingReplyStore } from "./pending-reply-recheck-store.js";

const url = process.env.NOELLE_RECHECK_RACES_TEST_DATABASE_URL;
const org = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000011";
const meta: ReplyReviewMeta = { pass:true,judgeOk:true,judgeProvider:"jev",attempts:0,reasons:[],
  scores:{ voice:0.9,grounding:0.9,relevance:0.9,format:1,novelty:1,diversity:1 } };
const marker = { version:2 as const,bodySha256:"abc",contextSha256:"saved-context",outcome:"passed" as const,checkedAt:new Date().toISOString() };

describe.skipIf(!url)("recovery review snapshots (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  const queries: string[] = [];
  beforeAll(async () => {
    sql = postgres(url!, { max:6,onnotice:() => {},debug:(_connection,query) => { queries.push(query); } });
    const [database] = await sql`select current_database() as name`;
    if (!database?.name.endsWith("_reply_recheck_races_test")) throw new Error("Dedicated test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql","0004_drafts_sent_at.sql","0003_x_watchlist.sql","0005_leads_full_schema.sql","0018_x_watchlist_people.sql","0107_linkedin_reply_claims.sql","0108_x_browser_discovery.sql"])
      await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema",file),"utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.x_reply_claims,noelle.linkedin_reply_claims,noelle.approvals,noelle.drafts,noelle.leads,noelle.agent_instances,noelle.organizations cascade`;
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
      values (${org},${owner},'101',${platform},'{"text":"original source","anchors":["plain voice"]}') returning id`;
    const [draft] = await sql`insert into noelle.drafts (org_id,lead_id,payload)
      values (${org},${lead!.id},'{"kind":"reply","body":"original body","verifier_meta":{"pass":false,"judgeOk":true}}') returning id`;
    await sql`insert into noelle.approvals (org_id,agent_instance_id,lead_id,draft_id,status)
      values (${org},${owner},${lead!.id},${draft!.id},'pending')`;
    return (await postgresPendingReplyStore(sql).list(org))[0]!;
  }
  const save = (row: PendingReplyCandidate) => postgresPendingReplyStore(sql).save(row,"original body",meta,marker);

  it("allows a new context digest after a rejection for the same body", async () => {
    const first = await candidate();
    const next = { version: 2, bodySha256: "same-body", contextSha256: "current-context", outcome: "passed",
      checkedAt: new Date().toISOString() } as ReplyRecheckMarker;
    await sql`update noelle.drafts set payload=payload||${sql.json({ reply_recheck: {
      ...next, contextSha256: "obsolete-context", outcome: "rejected" } })} where id=${first.draftId}`;
    const row = (await postgresPendingReplyStore(sql).list(org))[0]!;
    expect(await postgresPendingReplyStore(sql).save(row, "original body", meta, next)).toBe(true);
    expect((await sql`select payload->'reply_recheck' as marker from noelle.drafts`)[0]?.marker)
      .toMatchObject({ version: 2, contextSha256: "current-context" });
  });
  it("rejects a changed saved factual snapshot without replacing its review", async () => {
    const first = await candidate();
    await sql`update noelle.drafts set payload=payload||'{"review_context":{"version":1,"platform":"x","postText":"source","knowledgeAnchors":[]}}'`;
    const row = (await postgresPendingReplyStore(sql).list(org))[0]!;
    await sql`update noelle.drafts set payload=jsonb_set(payload,'{review_context,knowledgeAnchors}','["later fact"]') where id=${first.draftId}`;
    expect(await save(row)).toBe(false);
    expect((await sql`select payload->'verifier_meta' as review from noelle.drafts`)[0]?.review).toMatchObject({ pass: false });
  });
  it("rechecks the complete factual snapshot after waiting for a draft lock", async () => {
    await candidate();
    await sql`update noelle.drafts set payload=payload||'{"review_context":{"version":1,"platform":"x","postText":"source","knowledgeAnchors":[]}}'`;
    const row = (await postgresPendingReplyStore(sql).list(org))[0]!;
    let unlock!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const change = sql.begin(async tx => {
      await tx`update noelle.drafts set payload=jsonb_set(payload,'{review_context,knowledgeAnchors}','["later fact"]') where id=${row.draftId}`;
      locked();
      await gate;
    });
    await ready;
    let settled = false;
    const saved = save(row).then(value => { settled = true; return value; });
    try {
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        blocked = (await sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock') as blocked`)[0]?.blocked === true;
        if (blocked || settled) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(settled).toBe(false);
      expect(blocked).toBe(true);
    } finally {
      unlock();
      await change;
      await saved;
    }
    expect(await saved).toBe(false);
    expect((await sql`select payload->'verifier_meta' as review from noelle.drafts`)[0]?.review).toMatchObject({ pass: false });
  });

  it("saves one unchanged owned snapshot and rejects a repeated or foreign save", async () => {
    await sql`update noelle.agent_instances set model_overrides='{"workers":{"drafter":{"primary":{"engine":"bedrock","model":"claude-sonnet-4-6"}}}}'`;
    const row = await candidate();
    expect(row.modelOverrides).toMatchObject({ workers:{ drafter:{ primary:{ engine:"bedrock",model:"claude-sonnet-4-6" } } } });
    expect(await save({ ...row,orgId:"00000000-0000-4000-8000-000000000002" })).toBe(false);
    expect(await save(row)).toBe(true);
    expect(await save(row)).toBe(false);
    expect((await sql`select payload->'verifier_meta' as review from noelle.drafts where id=${row.draftId}`)[0]?.review).toMatchObject({ pass:true,judgeOk:true });
  });
  it("loads at most200 snapshots without enriching the unreviewed backlog", async () => {
    const first = await candidate();
    await sql`with more as (
      insert into noelle.drafts (org_id,lead_id,payload)
      select ${org}::uuid,${first.leadId}::uuid,'{"kind":"reply","body":"another reply"}'::jsonb from generate_series(1,200)
      returning id,lead_id
    ) insert into noelle.approvals (org_id,agent_instance_id,lead_id,draft_id,status)
      select ${org}::uuid,${instance}::uuid,lead_id,id,'pending' from more`;
    queries.length = 0;
    expect(await postgresPendingReplyStore(sql).list(org)).toHaveLength(200);
    expect(queries.filter(query => query.includes("coalesce(nullif(d.payload"))).toEqual([]);
  });
  it.each(["source","consent","instance"])("rejects a stale recovery result after %s changes", async field => {
    const row = await candidate();
    if (field === "source") await sql`update noelle.leads set payload=payload||'{"text":"corrected source"}' where id=${row.leadId}`;
    if (field === "consent") await sql`update noelle.drafts set payload=payload||'{"human_review_required":true}' where id=${row.draftId}`;
    if (field === "instance") {
      const [other] = await sql`insert into noelle.agent_instances (org_id,role) values (${org},'linkedin_intern') returning id`;
      await sql`update noelle.leads set agent_instance_id=${other!.id} where id=${row.leadId}`;
      await sql`update noelle.approvals set agent_instance_id=${other!.id} where id=${row.approvalId}`;
    }
    expect(await save(row)).toBe(false);
  });
  it("keeps edited and already sent drafts out of recovery saves", async () => {
    const row = await candidate();
    await sql`update noelle.drafts set payload=payload||'{"edited_body":"new body"}' where id=${row.draftId}`;
    expect(await save(row)).toBe(false);
    await sql`update noelle.drafts set payload=payload-'edited_body',sent_at=now() where id=${row.draftId}`;
    expect(await save(row)).toBe(false);
    expect(await postgresPendingReplyStore(sql).list(org)).toEqual([]);
  });
  it.each(["x","linkedin"])("does not recover a permanently reserved %s reply", async platform => {
    const row = await candidate(platform);
    if (platform === "x") await sql`insert into noelle.x_reply_claims (org_id,tweet_id,approval_id) values (${org},'101',${row.approvalId})`;
    else await sql`insert into noelle.linkedin_reply_claims (org_id,activity_urn,approval_id) values (${org},'urn:li:activity:101',${row.approvalId})`;
    expect(await save(row)).toBe(false);
    expect(await postgresPendingReplyStore(sql).list(org)).toEqual([]);
  });
  it("recovers a textual passing verdict that has never passed the native boolean gate", async () => {
    await candidate();
    await sql`update noelle.drafts set payload=payload||'{"verifier_meta":{"pass":"true","judgeOk":"true"}}'`;
    expect(await save((await postgresPendingReplyStore(sql).list(org))[0]!)).toBe(true);
  });
  it("waits for a committing operator skip before saving a review", async () => {
    const row = await candidate();
    let unlock!: () => void; let locked!: () => void;
    const gate = new Promise<void>(resolve => { unlock=resolve; });
    const ready = new Promise<void>(resolve => { locked=resolve; });
    const decision = sql.begin(async tx => {
      await tx`update noelle.approvals set status='skipped' where id=${row.approvalId}`;
      locked(); await gate;
    });
    await ready;
    let settled = false; const saved = save(row).then(value => { settled=true;return value; });
    try {
      let blocked = false;
      for (let i=0;i<100;i++) {
        blocked = (await sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock') as blocked`)[0]?.blocked === true;
        if (blocked || settled) break;
        await new Promise(resolve => setTimeout(resolve,10));
      }
      expect(settled).toBe(false); expect(blocked).toBe(true);
    } finally { unlock();await decision; }
    expect(await saved).toBe(false);
  });
});

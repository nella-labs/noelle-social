import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { discoveryReplyCapacity } from "./discovery-capacity.js";
import { actuator, fetchXRepliedTweetIds } from "./actuator.js";
import { actorReplyCap } from "./actor-reply-cap.js";

const org = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000011";
vi.mock("../middleware/actuator.js", () => ({ requireActuatorToken: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => { c.set("actuator", { orgId: "00000000-0000-4000-8000-000000000001" }); await next(); } }));
const url = process.env.NOELLE_X_BROWSER_CLAIMS_TEST_DATABASE_URL;

describe.skipIf(!url)("browser X reservations (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 12, onnotice: () => {} });
    const db = (await sql<{ db: string }[]>`select current_database() as db`)[0]?.db;
    if (!db?.endsWith("_x_browser_claims_test")) throw new Error(`refusing to reset non-dedicated database ${db}`);
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0004_drafts_sent_at.sql", "0003_x_watchlist.sql", "0005_leads_full_schema.sql", "0015_auto_send.sql", "0018_x_watchlist_people.sql", "0081_reply_send_enabled.sql", "0083_x_activity.sql", "0106_tenant_scoped_lead_identity.sql", "0108_x_browser_discovery.sql", "0110_actuator_daily_reply_cap.sql", "0126_x_daily_reply_cap_variation.sql", "0115_notification_conversation_index.sql"])
      await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema", file), "utf8"));
    await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema/0115_notification_conversation_index.sql"), "utf8"));
  });
  beforeEach(async () => {
    vi.unstubAllEnvs();
    __setDbClientForTests(sql);
    await sql`truncate noelle.x_reply_claims, noelle.x_activity, noelle.approvals, noelle.drafts, noelle.leads, noelle.agent_instances, noelle.organizations cascade`;
    await sql`insert into noelle.organizations (id,slug,name) values (${org},'one','One')`;
    await sql`insert into noelle.agent_instances (id,org_id,role,reply_send_enabled,actuator_daily_reply_cap) values (${instance},${org},'x_intern',true,40)`;
  });
  afterAll(async () => { vi.unstubAllEnvs(); resetDbClientForTests(); await sql?.end(); });
  async function candidate(target = "101", source = "search", hours = 1) {
    const [lead] = await sql<{ id: string }[]>`insert into noelle.leads (org_id,agent_instance_id,external_id,platform,author_handle,payload)
      values (${org},${instance},${target},'x','same_author',jsonb_build_object('source',${source}::text,'posted_at',to_char(now()-make_interval(hours=>${hours}), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) returning id`;
    const [draft] = await sql<{ id: string }[]>`insert into noelle.drafts (org_id,lead_id,payload)
      values (${org},${lead!.id},'{"kind":"reply","body":"supported reply","verifier_meta":{"pass":true,"judgeOk":true}}') returning id`;
    const [approval] = await sql<{ id: string }[]>`insert into noelle.approvals (org_id,agent_instance_id,draft_id,lead_id,status)
      values (${org},${instance},${draft!.id},${lead!.id},'pending') returning id`;
    return { id: approval!.id, draftId: draft!.id };
  }
  async function claim(id: string) {
    const response = await actuator.request(`/api/x-actuator/claim-reply/${id}`, { method: "POST" });
    return { status: response.status, body: await response.json() as { claimed: boolean; reason?: string } };
  }
  async function capState() {
    const response = await actorReplyCap.request(`/api/actuator/reply-cap?platform=x&instanceId=${instance}`);
    expect(response.status).toBe(200);
    return response.json();
  }
  async function inbound(target: string, author = "builder", platform = "x", root: string | null = "100") {
    const response = await actuator.request('/api/actuator/inbound-reply', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: instance, platform, items: [{
        external_id: target, author_handle: author, text: 'A concrete follow-up',
        url: `https://x.com/builder/status/${target}`, posted_at: new Date().toISOString(),
        conversation: { root_post_id: root },
      }] }),
    });
    return { status: response.status, body: await response.json() as { accepted: number; results: { reason?: string }[] } };
  }
  it("keeps parallel notification ingests within one conversation's turn limit", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => inbound(String(201+i))));
    expect(results.reduce((n, result) => n + result.body.accepted, 0)).toBe(2);
    const rows = await sql`select payload->>'prior_turns' as prior from noelle.leads order by created_at`;
    expect(rows.map(row => Number(row.prior)).sort()).toEqual([0,1]);
  });
  it("normalizes author fallback keys when the notification root is missing", async () => {
    expect((await inbound('201', '@Builder', 'x', null)).body.accepted).toBe(1);
    await sql`update noelle.leads set payload=jsonb_set(payload,'{conversation_key}','"author:@Builder"'::jsonb)`;
    expect((await inbound('202', 'builder', 'x', null)).body.accepted).toBe(1);
    expect((await inbound('203', '@BUILDER', 'x', null)).body.results[0]?.reason).toBe('turn-cap');
  });
  it("reports repeated notification identity as duplicate after the turn cap fills", async () => {
    await inbound('201'); await inbound('202');
    expect((await inbound('201')).body.results[0]?.reason).toBe('duplicate');
    expect(await sql`select * from noelle.leads`).toHaveLength(2);
  });
  it("rejects notification ingestion into another platform's instance", async () => {
    expect((await inbound('201', 'builder', 'linkedin')).status).toBe(403);
    expect(await sql`select * from noelle.leads`).toHaveLength(0);
  });
  it("preserves a notification kill switch without spending a conversation turn", async () => {
    vi.stubEnv('NOELLE_NOTIFICATION_MAX_TURNS','0');
    expect((await inbound('201')).body.results[0]?.reason).toBe('turn-cap');
    expect(await sql`select * from noelle.leads`).toHaveLength(0);
  });
  it("reports reservations in remaining capacity without calling them confirmed sends", async () => {
    await sql`update noelle.agent_instances set actuator_daily_reply_cap=3 where id=${instance}`;
    const row = await candidate();
    expect((await claim(row.id)).body.claimed).toBe(true);
    expect(await capState()).toEqual({ sent: 0, cap: 3, remaining: 2 });
    await sql`insert into noelle.x_activity (org_id,session_id,type,tweet_id) values (${org},gen_random_uuid(),'reply','101')`;
    expect(await capState()).toEqual({ sent: 1, cap: 3, remaining: 2 });
  });
  it("serves no new card once permanent reservations occupy the daily cap", async () => {
    await sql`update noelle.agent_instances set actuator_daily_reply_cap=1 where id=${instance}`;
    const first = await candidate();
    expect((await claim(first.id)).body.claimed).toBe(true);
    await candidate('102');
    const response = await actuator.request(`/api/actionable-x?instanceId=${instance}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ replies: [] });
  });
  it("counts parallel reservations toward the same author's daily cap", async () => {
    vi.stubEnv("NOELLE_X_ACTUATOR_PER_AUTHOR_DAILY_CAP", "1");
    const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => candidate(String(101+i))));
    const results = await Promise.all(rows.map(row => claim(row.id)));
    expect(results.filter(r => r.body.claimed)).toHaveLength(1);
    expect(await sql`select * from noelle.x_reply_claims`).toHaveLength(1);
  });
  it("keeps the instance cap atomic across different authors", async () => {
    await sql`update noelle.agent_instances set actuator_daily_reply_cap=3 where id=${instance}`;
    const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => candidate(String(101+i))));
    for (let i=0; i<rows.length; i++) await sql`update noelle.leads set author_handle=${"author_"+i} where id=(select lead_id from noelle.approvals where id=${rows[i]!.id})`;
    expect((await Promise.all(rows.map(row => claim(row.id)))).filter(r => r.body.claimed)).toHaveLength(3);
    expect(await sql`select * from noelle.x_reply_claims`).toHaveLength(3);
  });
  it("uses today's persisted sample for queue, priority, health and claims", async () => {
    await sql`update noelle.agent_instances set actuator_daily_reply_cap=2,actuator_daily_reply_cap_min=1,
      actuator_daily_reply_cap_day=current_date,actuator_daily_reply_cap_effective=1 where id=${instance}`;
    const first = await candidate("101", "extension_observed");
    const second = await candidate("102", "extension_observed");
    await sql`update noelle.leads set payload=payload||'{"classifier":{"judge":"jev"}}'::jsonb`;
    const [date] = await sql<{ day: string }[]>`select current_date::text as day`;
    expect(await capState()).toEqual({ sent: 0, cap: 1, remaining: 1, configuredCap: 2, minimum: 1, day: date!.day });
    for (const path of ["/api/actionable-x", "/api/actionable-x/priority-ready"]) {
      const response = await actuator.request(`${path}?instanceId=${instance}`);
      expect(response.status).toBe(200);
      expect((await response.json() as { replies: unknown[] }).replies).toHaveLength(1);
    }
    const health = await actuator.request(`/api/actuator/x-health?instanceId=${instance}`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ today: { writeCap: 1, replies: 0 } });
    const claims = await Promise.all([claim(first.id), claim(second.id)]);
    expect(claims.filter(result => result.body.claimed)).toHaveLength(1);
    expect(claims.find(result => !result.body.claimed)?.body.reason).toBe("daily-cap");
    expect(await capState()).toMatchObject({ sent: 0, cap: 1, remaining: 0 });
    expect(await sql`select * from noelle.x_reply_claims`).toHaveLength(1);
  });
  it("rolls yesterday's sample once before concurrent reservation admission", async () => {
    await sql`update noelle.agent_instances set actuator_daily_reply_cap=3,actuator_daily_reply_cap_min=1,
      actuator_daily_reply_cap_day=current_date-1,actuator_daily_reply_cap_effective=3 where id=${instance}`;
    const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => candidate(String(101+i))));
    for (let i=0; i<rows.length; i++) await sql`update noelle.leads set author_handle=${"author_"+i}
      where id=(select lead_id from noelle.approvals where id=${rows[i]!.id})`;
    const results = await Promise.all(rows.map(row => claim(row.id)));
    const current = await capState() as { cap: number; remaining: number };
    expect([1, 2]).toContain(current.cap);
    expect(current.remaining).toBe(0);
    expect(results.filter(result => result.body.claimed)).toHaveLength(current.cap);
    expect(await sql`select * from noelle.x_reply_claims`).toHaveLength(current.cap);
    expect(await capState()).toEqual(current);
  });
  it("counts confirmed author activity whose target ID was not recorded", async () => {
    vi.stubEnv("NOELLE_X_ACTUATOR_PER_AUTHOR_DAILY_CAP", "1");
    const row = await candidate();
    await sql`insert into noelle.x_activity (org_id,session_id,type,author_handle) values (${org},gen_random_uuid(),'reply','@SAME_AUTHOR')`;
    expect((await claim(row.id)).body).toMatchObject({ claimed: false, reason: "per-author-cap" });
    expect(await sql`select * from noelle.x_reply_claims`).toHaveLength(0);
  });
  it("keeps an existing platform receipt out of browser dispatch", async () => {
    const row = await candidate();
    await sql`update noelle.drafts set sent_external_id='202',sent_at=now() where id=${row.draftId}`;
    expect((await claim(row.id)).body.claimed).toBe(false);
    expect(await sql`select * from noelle.x_reply_claims`).toHaveLength(0);
  });
  it("uses the shared link policy before browser dispatch", async () => {
    const row = await candidate();
    await sql`update noelle.drafts set payload=payload||'{"body":"details at example[.]com"}' where id=${row.draftId}`;
    expect((await claim(row.id)).body.claimed).toBe(false);
    expect(await sql`select * from noelle.x_reply_claims`).toHaveLength(0);
  });
  it("reads permanent evidence only for the requested target batch", async () => {
    await sql`insert into noelle.x_activity (org_id,session_id,type,tweet_id) values
      (${org},gen_random_uuid(),'reply','101'),(${org},gen_random_uuid(),'skip','102'),
      (${org},gen_random_uuid(),'like','103'),(${org},gen_random_uuid(),'reply','999')`;
    await sql`insert into noelle.x_reply_claims (org_id,tweet_id,approval_id) values (${org},'104',gen_random_uuid())`;
    const sent = await candidate('105');
    await sql`update noelle.approvals set status='sent' where id=${sent.id}`;
    expect(await fetchXRepliedTweetIds(sql,org,['101','102','103','104','105'])).toEqual(new Set(['101','102','104','105']));
    expect(await fetchXRepliedTweetIds(sql,org,[])).toEqual(new Set());
    await expect(fetchXRepliedTweetIds(sql,org,Array(501).fill('101'))).rejects.toThrow('500');
  });
  it.each(["pass", "judgeOk"])("does not count a textual %s verdict as a reviewed discovery slot", async field => {
    const row = await candidate("101", "extension_observed");
    await sql`update noelle.drafts set payload=jsonb_set(payload,array['verifier_meta',${field}],'"true"'::jsonb) where id=${row.draftId}`;
    expect(await discoveryReplyCapacity(sql,{ orgId: org, instanceId: instance, platform: "x" })).toEqual({ limit: 12, occupied: 0, available: 12 });
  });
  it("excludes a discovery slot joined to another tenant's draft", async () => {
    const row = await candidate("101", "extension_observed");
    const otherOrg = "00000000-0000-4000-8000-000000000002";
    await sql`insert into noelle.organizations (id,slug,name) values (${otherOrg},'two','Two')`;
    await sql`update noelle.drafts set org_id=${otherOrg} where id=${row.draftId}`;
    expect((await discoveryReplyCapacity(sql,{ orgId: org, instanceId: instance, platform: "x" })).occupied).toBe(0);
  });
  it("applies the conversation window when reserving a notification reply", async () => {
    const row = await candidate("101", "notification", 14);
    expect((await claim(row.id)).body.claimed).toBe(false);

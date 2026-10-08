import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { NOTIFICATION_MAX_AGE_HOURS, sourceTimestampSql } from "@noelle/runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimAutoSendDue, expireStaleApprovals, releaseAutoSendRowsForReview, listRetrySendDue } from "./send-db.js";
import { expireStaleClassifiedLeads } from "./leads-db.js";

const url = process.env.NOELLE_X_SEND_DATES_TEST_DATABASE_URL;
const org = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000011";
const foreignOrg = "00000000-0000-4000-8000-000000000002";
const foreignInstance = "00000000-0000-4000-8000-000000000012";

describe.skipIf(!url)("X source date handling (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    const db = (await sql<{ db: string }[]>`select current_database() as db`)[0]?.db;
    if (!db?.endsWith("_x_send_dates_test")) throw new Error(`refusing to reset non-dedicated database ${db}`);
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0004_drafts_sent_at.sql", "0003_x_watchlist.sql", "0005_leads_full_schema.sql", "0015_auto_send.sql", "0019_worker_enabled.sql", "0081_reply_send_enabled.sql", "0018_x_watchlist_people.sql", "0108_x_browser_discovery.sql", "0096_notification_window_12h.sql", "0113_source_reply_dates.sql", "0114_safe_drafting_dates.sql", "0113_source_reply_dates.sql", "0114_safe_drafting_dates.sql"])
      await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.approvals, noelle.drafts, noelle.leads, noelle.agent_instances, noelle.organizations cascade`;
    await sql`insert into noelle.organizations (id,slug,name) values (${org},'one','One')`;
    await sql`insert into noelle.agent_instances (id,org_id,role,reply_send_enabled) values (${instance},${org},'x_intern',true)`;
  });
  afterAll(async () => { await sql?.end(); });

  async function candidate(postedAt: string | null, status = "pending", source = "search") {
    const [lead] = await sql<{ id: string }[]>`insert into noelle.leads (org_id,agent_instance_id,external_id,platform,status,payload)
      values (${org},${instance},gen_random_uuid()::text,'x','classified',${sql.json({ source, ...(postedAt ? { posted_at: postedAt } : {}) })}) returning id`;
    const [draft] = await sql<{ id: string }[]>`insert into noelle.drafts (org_id,lead_id,payload)
      values (${org},${lead!.id},'{"kind":"reply","body":"reply","verifier_meta":{"pass":true,"judgeOk":true}}') returning id`;
    const [approval] = await sql<{ id: string }[]>`insert into noelle.approvals (org_id,agent_instance_id,draft_id,lead_id,status,auto_send_target_at)
      values (${org},${instance},${draft!.id},${lead!.id},${status},now()-interval '1 minute') returning id`;
    return { leadId: lead!.id, draftId: draft!.id, approvalId: approval!.id };
  }

  it("claims fresh and undateable rows without an ISO-shaped invalid date poisoning the batch", async () => {
    const invalid = await candidate("2026-13-99T10:00:00Z");
    const fresh = await candidate(new Date(Date.now() - 3_600_000).toISOString());
    const stale = await candidate(new Date(Date.now() - 72 * 3_600_000).toISOString());
    const claimed = await claimAutoSendDue(sql, { agentInstanceId: instance, budget: 5, maxAgeHours: 24 });
    expect(claimed.map((row) => row.draft_id).sort()).toEqual([invalid.draftId, fresh.draftId].sort());
    expect((await sql<{ status: string }[]>`select status from noelle.approvals where id=${stale.approvalId}`)[0]?.status).toBe("pending");
  });

  it("expires only known stale pending and limbo targets despite malformed source dates", async () => {
    const invalid = await candidate("2026-02-30T10:00:00Z");
    await candidate("2026-13-99T10:00:00Z", "sent");
    await candidate(new Date(Date.now() - 72 * 3_600_000).toISOString());
    await candidate(new Date(Date.now() - 72 * 3_600_000).toISOString(), "sent");
    expect(await expireStaleApprovals(sql, { agentInstanceId: instance, maxAgeHours: 24 })).toEqual({ pending: 1, limbo: 1 });
    expect((await sql<{ status: string }[]>`select status from noelle.approvals where id=${invalid.approvalId}`)[0]?.status).toBe("pending");
  });

  it("does not lose the classified-lead sweep because one saved date is invalid", async () => {
    const invalid = await candidate("2026-13-99T10:00:00Z");
    const unknown = await candidate(null);
    const stale = await candidate(new Date(Date.now() - 72 * 3_600_000).toISOString());
    expect(await expireStaleClassifiedLeads(sql, { agentInstanceId: instance, maxAgeHours: 24 })).toBe(1);
    expect(await sql`select id, status from noelle.leads order by id`).toEqual(expect.arrayContaining([
      { id: invalid.leadId, status: "classified" }, { id: unknown.leadId, status: "classified" }, { id: stale.leadId, status: "skipped" },
    ]));
  });
  it("uses the notification window instead of widening it to the cold-reply ceiling", async () => {
    const fresh = await candidate(new Date(Date.now() - (NOTIFICATION_MAX_AGE_HOURS - 1) * 3_600_000).toISOString(), "pending", "notification");
    const stale = await candidate(new Date(Date.now() - (NOTIFICATION_MAX_AGE_HOURS + 1) * 3_600_000).toISOString(), "pending", "notification");
    const cold = await candidate(new Date(Date.now() - (NOTIFICATION_MAX_AGE_HOURS + 1) * 3_600_000).toISOString());
    const claimed = await claimAutoSendDue(sql, { agentInstanceId: instance, budget: 5, maxAgeHours: 24 });
    expect(claimed.map((row) => row.draft_id).sort()).toEqual([fresh.draftId, cold.draftId].sort());
    expect(await expireStaleApprovals(sql, { agentInstanceId: instance, maxAgeHours: 24 })).toEqual({ pending: 1, limbo: 0 });
    expect((await sql<{ status: string }[]>`select status from noelle.approvals where id=${stale.approvalId}`)[0]?.status).toBe("expired");
    expect(await expireStaleClassifiedLeads(sql, { agentInstanceId: instance, maxAgeHours: 24 })).toBe(1);
  });

  it("preserves ISO dates and legacy PostgreSQL dates without inventing timestamps for invalid data", async () => {
    for (const value of [null, "", "2026-02-30T10:00:00Z", "2026-13-99T10:00:00Z", "tomorrow"]) {
      expect((await sql<{ at: Date | null }[]>`select ${sourceTimestampSql(sql, sql`${value}::text`)} as at`)[0]?.at).toBeNull();
    }
    const [iso] = await sql<{ at: Date }[]>`select ${sourceTimestampSql(sql, sql`${"2026-01-01T10:00:00Z"}::text`)} as at`;
    expect(iso?.at.toISOString()).toBe("2026-01-01T10:00:00.000Z");
    const [legacy] = await sql<{ at: Date }[]>`select ${sourceTimestampSql(sql, sql`${"2026-01-01 10:00:00+00"}::text`, "postgres")} as at`;
    expect(legacy?.at.toISOString()).toBe("2026-01-01T10:00:00.000Z");
  });

  it.each(["cold", "watchlist", "notification"] as const)("keeps malformed dates from poisoning the %s drafting RPC", async (lane) => {
    const source = lane === "notification" ? "notification" : "search";
    const invalid = await candidate("2026-13-99T10:00:00Z", "pending", source);
    const fresh = await candidate(new Date(Date.now() - 3_600_000).toISOString(), "pending", source);
    const stale = await candidate(new Date(Date.now() - 72 * 3_600_000).toISOString(), "pending", source);
    await sql`delete from noelle.approvals`;
    await sql`delete from noelle.drafts`;
    await sql`update noelle.leads set priority=${lane === "watchlist"}, author_handle=id::text`;
    const rows = lane === "cold"
      ? await sql<{ id: string }[]>`select * from noelle.claim_leads_for_drafting(${instance}::uuid, 5, 24)`
      : lane === "watchlist"
        ? await sql<{ id: string }[]>`select * from noelle.claim_watchlist_leads_for_drafting(${instance}::uuid, 5, 24)`
        : await sql<{ id: string }[]>`select * from noelle.claim_notification_leads_for_drafting(${instance}::uuid, 5)`;
    expect(rows.map((row) => row.id).sort()).toEqual([invalid.leadId, fresh.leadId].sort());
    expect((await sql<{ status: string }[]>`select status from noelle.leads where id=${stale.leadId}`)[0]?.status).toBe("classified");
  });

  it("keeps parallel watchlist claimants from drafting multiple posts by the same person", async () => {
    for (let index = 0; index < 8; index++) await candidate(new Date(Date.now() - index * 60_000).toISOString());
    await sql`delete from noelle.approvals`;
    await sql`delete from noelle.drafts`;
    await sql`update noelle.leads set priority=true, author_handle=case when extract(second from created_at)::int % 2 = 0 then '@Watched' else 'watched' end`;
    const batches = await Promise.all(Array.from({ length: 8 }, () =>
      sql<{ id: string }[]>`select * from noelle.claim_watchlist_leads_for_drafting(${instance}::uuid, 5, 24)`));
    expect(batches.flat()).toHaveLength(1);
    expect((await sql<{ count: number }[]>`select count(*)::int as count from noelle.leads where status='drafting'`)[0]?.count).toBe(1);
  });

  it.each(["hour", "day", "halfHour"] as const)("keeps concurrent due claimants within the rolling %s cap", async (window) => {
    for (let index = 0; index < 16; index++) await candidate(new Date().toISOString());
    await sql`update noelle.agent_instances set auto_send_max_per_hour=${window === "hour" ? 3 : 20} where id=${instance}`;
    const batches = await Promise.all(Array.from({ length: 8 }, () => claimAutoSendDue(sql, {
      agentInstanceId: instance, budget: 2, maxAgeHours: 24,
      maxPerDay: window === "day" ? 3 : 20, maxPer30Min: window === "halfHour" ? 3 : 20,
    })));
    expect(batches.flat()).toHaveLength(3);
    expect((await sql<{ count: number }[]>`select count(*)::int as count from noelle.approvals where status='sent'`)[0]?.count).toBe(3);
  });

  it("rechecks the sending switch before claiming due work", async () => {
    await candidate(new Date().toISOString());
    await sql`update noelle.agent_instances set reply_send_enabled=false where id=${instance}`;
    expect(await claimAutoSendDue(sql, { agentInstanceId: instance, budget: 2 })).toEqual([]);
  });

  it("returns only undispatched auto claims to review and retains receipt/uncertainty holds", async () => {
    const unattempted = await candidate(null, "sent");
    const posted = await candidate(null, "sent");
    const uncertain = await candidate(null, "sent");
    await sql`update noelle.approvals set decided_by='auto-send',decided_at=now()`;
    await sql`update noelle.drafts set sent_external_id='1987654321000000000' where id=${posted.draftId}`;
    await sql`insert into noelle.x_reply_claims (org_id,tweet_id,approval_id) values (${org},'1987654321000000001',${uncertain.approvalId})`;
    await releaseAutoSendRowsForReview(sql, { draftIds: [unattempted.draftId,posted.draftId,uncertain.draftId] });
    expect(await sql<{ id: string; status: string }[]>`select id,status from noelle.approvals order by id`).toEqual(expect.arrayContaining([
      { id: unattempted.approvalId, status: "pending" },{ id: posted.approvalId, status: "sent" },{ id: uncertain.approvalId, status: "sent" },
    ]));
  });

  it("withholds a previously scheduled draft after its semantic review is invalidated", async () => {
    const edited = await candidate(new Date().toISOString());
    await sql`update noelle.drafts set payload=payload-'verifier_meta' where id=${edited.draftId}`;
    expect(await claimAutoSendDue(sql, { agentInstanceId: instance, budget: 5, maxAgeHours: 24 })).toEqual([]);
    expect((await sql<{ status: string }[]>`select status from noelle.approvals where id=${edited.approvalId}`)[0]?.status).toBe("pending");
  });

  const brokenContexts = ["draft-lead", "draft-org", "lead-org", "lead-instance", "lead-platform"] as const;
  async function breakContext(row: Awaited<ReturnType<typeof candidate>>, field: typeof brokenContexts[number]) {
    await sql`insert into noelle.organizations(id,slug,name) values (${foreignOrg},'two','Two')`;
    await sql`insert into noelle.agent_instances(id,org_id,role) values (${foreignInstance},${foreignOrg},'x_intern')`;
    if (field === "draft-lead") {
      const target = await candidate(new Date(Date.now()-72*3_600_000).toISOString());
      await sql`delete from noelle.approvals where id=${target.approvalId}`;
      await sql`update noelle.approvals set lead_id=${target.leadId} where id=${row.approvalId}`;
    } else if (field === "draft-org") await sql`update noelle.drafts set org_id=${foreignOrg} where id=${row.draftId}`;
    else if (field === "lead-org") await sql`update noelle.leads set org_id=${foreignOrg} where id=${row.leadId}`;
    else if (field === "lead-instance") await sql`update noelle.leads set agent_instance_id=${foreignInstance} where id=${row.leadId}`;
    else await sql`update noelle.leads set platform='linkedin' where id=${row.leadId}`;
  }

  it.each(brokenContexts)("does not auto-claim an incoherent %s context", async field => {
    const held = await candidate(new Date().toISOString());
    await breakContext(held, field);
    expect(await claimAutoSendDue(sql, { agentInstanceId: instance, budget: 5 })).toEqual([]);
    expect((await sql`select status from noelle.approvals where id=${held.approvalId}`)[0]?.status).toBe("pending");
  });

  it.each(brokenContexts)("does not expire pending or limbo approvals through an incoherent %s context", async field => {
    const stale = new Date(Date.now()-72*3_600_000).toISOString();
    const held = await candidate(stale);
    await breakContext(held, field);
    expect(await expireStaleApprovals(sql, { agentInstanceId: instance, maxAgeHours: 24 })).toEqual({ pending: 0, limbo: 0 });
    await sql`update noelle.approvals set status='sent' where id=${held.approvalId}`;
    expect(await expireStaleApprovals(sql, { agentInstanceId: instance, maxAgeHours: 24 })).toEqual({ pending: 0, limbo: 0 });
    expect((await sql`select status from noelle.approvals where id=${held.approvalId}`)[0]?.status).toBe("sent");
  });

  it.each(brokenContexts)("does not release an auto claim through an incoherent %s context", async field => {
    const held = await candidate(null, "sent");
    await breakContext(held, field);
    await sql`update noelle.approvals set decided_by='auto-send',decided_at=now() where id=${held.approvalId}`;
    await releaseAutoSendRowsForReview(sql, { draftIds: [held.draftId] });
    expect((await sql`select status from noelle.approvals where id=${held.approvalId}`)[0]?.status).toBe("sent");
  });

  it.each(brokenContexts)("does not retry a sent approval through an incoherent %s context", async field => {
    const held = await candidate(null, "sent");
    await breakContext(held, field);
    expect(await listRetrySendDue(sql, { agentInstanceId: instance, orgId: org, maxAgeHours: 0 })).toEqual([]);
  });

  it("does not retry a foreign approval that points to this instance's draft", async () => {

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimObservedLeadsForDrafting, countPendingApprovalsForInstance, createStartupDraftingRecovery, reapStaleClaims } from "./leads-db.js";

const url = process.env.NOELLE_TEST_DATABASE_URL;
const instanceId = "00000000-0000-4000-8000-000000000001";

describe.skipIf(!url)("LinkedIn reply backpressure (integration)", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    const [row] = await sql<{ db: string }[]>`select current_database() as db`;
    if (!row?.db.includes("test")) throw new Error("Reply backpressure tests require a test database");
  });

  beforeEach(async () => {
    await sql`begin`;
    await sql`drop schema if exists noelle cascade`;
    await sql`create schema noelle`;
    await sql`create table noelle.leads (
      id uuid primary key, org_id uuid not null default '00000000-0000-4000-8000-000000000009',
      agent_instance_id uuid not null, platform text not null,
      status text not null, payload jsonb not null, external_id text,
      author_handle text, author_id text, tier text, classifier_label text,
      classifier_score numeric, priority boolean, created_at timestamptz default now(),
      updated_at timestamptz default now()
    )`;
    await sql`create table noelle.drafts (
      id uuid primary key, lead_id uuid,
      org_id uuid not null default '00000000-0000-4000-8000-000000000009', payload jsonb not null
    )`;
    await sql`create table noelle.approvals (
      id uuid primary key default gen_random_uuid(),
      org_id uuid not null default '00000000-0000-4000-8000-000000000009',
      agent_instance_id uuid not null,
      lead_id uuid,
      draft_id uuid not null unique references noelle.drafts(id),
      status text not null
    )`;
  });

  afterEach(async () => { await sql`rollback`; });
  afterAll(async () => { await sql?.end(); });

  it("excludes pending DMs from the reply pipeline cap", async () => {
    await sql`insert into noelle.drafts (id, payload) values
      ('00000000-0000-4000-8000-000000000011', '{"kind":"dm"}'),
      ('00000000-0000-4000-8000-000000000012', '{"kind":"dm"}'),
      ('00000000-0000-4000-8000-000000000013', '{"kind":"reply"}'),
      ('00000000-0000-4000-8000-000000000014', '{}'),
      ('00000000-0000-4000-8000-000000000015', '{"kind":"reply"}')`;
    await sql`insert into noelle.approvals (id, agent_instance_id, draft_id, status) values
      ('00000000-0000-4000-8000-000000000021', ${instanceId}, '00000000-0000-4000-8000-000000000011', 'pending'),
      ('00000000-0000-4000-8000-000000000022', ${instanceId}, '00000000-0000-4000-8000-000000000012', 'pending'),
      ('00000000-0000-4000-8000-000000000023', ${instanceId}, '00000000-0000-4000-8000-000000000013', 'pending'),
      ('00000000-0000-4000-8000-000000000024', ${instanceId}, '00000000-0000-4000-8000-000000000014', 'pending'),
      ('00000000-0000-4000-8000-000000000025', ${instanceId}, '00000000-0000-4000-8000-000000000015', 'sent')`;

    expect(await countPendingApprovalsForInstance(sql, instanceId)).toBe(2);
  });

  it("claims observed posts when failed reviews are pending, including the same author", async () => {
    for (let n = 1; n <= 5; n++) {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const draftId = `00000000-0000-4000-8001-${String(n).padStart(12, "0")}`;
      const approvalId = `00000000-0000-4000-8002-${String(n).padStart(12, "0")}`;
      await sql`insert into noelle.leads (id, agent_instance_id, platform, status, payload, author_handle)
        values (${id}, ${instanceId}, 'linkedin', 'drafted', '{"source":"extension_observed"}', ${`author-${n}`})`;
      await sql`insert into noelle.drafts (id, lead_id, payload)
        values (${draftId}, ${id}, '{"kind":"reply","verifier_meta":{"pass":false,"judgeOk":true,"scores":{"voice":0.6}}}')`;
      await sql`insert into noelle.approvals (id, agent_instance_id, lead_id, draft_id, status)
        values (${approvalId}, ${instanceId}, ${id}, ${draftId}, 'pending')`;
    }
    const candidateId = "00000000-0000-4000-8003-000000000001";
    await sql`insert into noelle.leads (id, agent_instance_id, platform, status, payload, external_id, author_handle)
      values (${candidateId}, ${instanceId}, 'linkedin', 'classified',
        '{"source":"extension_observed","classifier":{"provider":"jev"},"urn":"urn:li:activity:123","url":"https://www.linkedin.com/feed/update/urn:li:activity:123/"}',
        '123', 'author-1')`;

    const claimed = await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 5 });
    expect(claimed.map((lead) => lead.id)).toEqual([candidateId]);
  });

  it("reconciles pre-start reply drafts, repairs missing approvals, and requeues DM-only claims", async () => {
    const bootAt = new Date(Date.now() - 10_000);
    const preStart = new Date(bootAt.getTime() - 60_000).toISOString();
    const afterStart = new Date(bootAt.getTime() + 1_000).toISOString();
    const staleSaved = new Date(bootAt.getTime() - 46 * 60_000).toISOString();
    const expired = new Date(bootAt.getTime() - 49 * 60 * 60_000).toISOString();
    const otherInstanceId = "00000000-0000-4000-8000-000000000002";
    const interruptedId = "00000000-0000-4000-8004-000000000001";
    const savedId = "00000000-0000-4000-8004-000000000002";
    const currentId = "00000000-0000-4000-8004-000000000003";
    const otherId = "00000000-0000-4000-8004-000000000004";
    const expiredId = "00000000-0000-4000-8004-000000000005";
    const orphanId = "00000000-0000-4000-8004-000000000006";
    const dmOnlyId = "00000000-0000-4000-8004-000000000007";
    const savedDraftId = "00000000-0000-4000-8005-000000000001";
    const orphanDraftId = "00000000-0000-4000-8005-000000000002";
    await sql`insert into noelle.leads (id, agent_instance_id, platform, status, payload, updated_at) values
      (${interruptedId}, ${instanceId}, 'linkedin', 'drafting', '{}', ${preStart}),
      (${savedId}, ${instanceId}, 'linkedin', 'drafting', '{}', ${staleSaved}),
      (${currentId}, ${instanceId}, 'linkedin', 'drafting', '{}', ${afterStart}),
      (${otherId}, ${otherInstanceId}, 'linkedin', 'drafting', '{}', ${preStart}),
      (${expiredId}, ${instanceId}, 'linkedin', 'drafting', '{}', ${expired}),
      (${orphanId}, ${instanceId}, 'linkedin', 'drafting', '{}', ${staleSaved}),
      (${dmOnlyId}, ${instanceId}, 'linkedin', 'drafting', '{}', ${preStart})`;
    await sql`insert into noelle.drafts (id, lead_id, payload) values
      (${savedDraftId}, ${savedId}, '{"kind":"reply","verifier_meta":{"pass":true}}'),
      (${orphanDraftId}, ${orphanId}, '{"kind":"reply","verifier_meta":{"pass":false}}'),
      ('00000000-0000-4000-8005-000000000003', ${dmOnlyId}, '{"kind":"dm"}')`;
    await sql`insert into noelle.approvals (id, agent_instance_id, lead_id, draft_id, status)
      values ('00000000-0000-4000-8006-000000000001', ${instanceId}, ${savedId}, ${savedDraftId}, 'pending')`;

    const recover = createStartupDraftingRecovery(sql, bootAt);
    expect(await recover(instanceId)).toEqual({ requeued: 2, reconciled: 2, approvalsRepaired: 1 });
    expect(await recover(instanceId)).toEqual({ requeued: 0, reconciled: 0, approvalsRepaired: 0 });
    const afterBoot = await sql<{ id: string; status: string }[]>`
      select id, status from noelle.leads order by id`;
    expect(Object.fromEntries(afterBoot.map(({ id, status }) => [id, status]))).toEqual({
      [interruptedId]: "classified",
      [savedId]: "drafted",
      [currentId]: "drafting",
      [otherId]: "drafting",
      [expiredId]: "drafting",
      [orphanId]: "drafted",
      [dmOnlyId]: "classified",
    });
    const approvals = await sql<{ draft_id: string; status: string }[]>`
      select draft_id, status from noelle.approvals order by draft_id`;
    expect(approvals).toEqual([
      { draft_id: savedDraftId, status: "pending" },
      { draft_id: orphanDraftId, status: "pending" },
    ]);
    const [draftCount] = await sql<{ count: string }[]>`select count(*)::text as count from noelle.drafts`;
    expect(draftCount?.count).toBe("3");

    expect(await reapStaleClaims(sql, {
      agentInstanceId: instanceId,
      claimedStatus: "drafting",
      requeueStatus: "classified",
    })).toEqual({ requeued: 0, expired: 1, reconciled: 0, approvalsRepaired: 0 });
    const [old] = await sql<{ status: string }[]>`select status from noelle.leads where id = ${expiredId}`;
    expect(old?.status).toBe("skipped");
  });

  it("the 45-minute reaper reconciles saved replies and requeues an old DM-only claim", async () => {
    const stale = new Date(Date.now() - 46 * 60_000).toISOString();
    const savedId = "00000000-0000-4000-8007-000000000001";
    const orphanId = "00000000-0000-4000-8007-000000000002";
    const dmOnlyId = "00000000-0000-4000-8007-000000000003";
    const savedDraftId = "00000000-0000-4000-8008-000000000001";
    const orphanDraftId = "00000000-0000-4000-8008-000000000002";
    await sql`insert into noelle.leads (id, agent_instance_id, platform, status, payload, updated_at) values
      (${savedId}, ${instanceId}, 'linkedin', 'drafting', '{}', ${stale}),
      (${orphanId}, ${instanceId}, 'linkedin', 'drafting', '{}', ${stale}),
      (${dmOnlyId}, ${instanceId}, 'linkedin', 'drafting', '{}', ${stale})`;
    await sql`insert into noelle.drafts (id, lead_id, payload) values
      (${savedDraftId}, ${savedId}, '{"kind":"reply"}'),
      (${orphanDraftId}, ${orphanId}, '{"kind":"reply"}'),
      ('00000000-0000-4000-8008-000000000003', ${dmOnlyId}, '{"kind":"dm"}')`;
    await sql`insert into noelle.approvals (id, agent_instance_id, lead_id, draft_id, status)
      values ('00000000-0000-4000-8009-000000000001', ${instanceId}, ${savedId}, ${savedDraftId}, 'pending')`;

    expect(await reapStaleClaims(sql, {
      agentInstanceId: instanceId,
      claimedStatus: "drafting",
      requeueStatus: "classified",
    })).toEqual({ requeued: 1, expired: 0, reconciled: 2, approvalsRepaired: 1 });
    const rows = await sql<{ id: string; status: string }[]>`select id, status from noelle.leads order by id`;
    expect(Object.fromEntries(rows.map(({ id, status }) => [id, status]))).toEqual({
      [savedId]: "drafted",
      [orphanId]: "drafted",
      [dmOnlyId]: "classified",
    });
    const [approvals] = await sql<{ count: string }[]>`select count(*)::text as count from noelle.approvals`;
    expect(approvals?.count).toBe("2");
    expect(await reapStaleClaims(sql, {
      agentInstanceId: instanceId,
      claimedStatus: "drafting",
      requeueStatus: "classified",
    })).toEqual({ requeued: 0, expired: 0, reconciled: 0, approvalsRepaired: 0 });
  });
});

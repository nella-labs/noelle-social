import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { passesUnattendedReplyReview } from "@noelle/contracts";
import { unattendedReplyReviewSql } from "./unattendedReplyReviewSql.js";
import { reserveXReplyClaim, releaseXReplyClaim } from "./xReplyClaimsDb.js";

const url = process.env.NOELLE_X_REPLY_CLAIMS_TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const org = "00000000-0000-4000-8000-000000000001";
const otherOrg = "00000000-0000-4000-8000-000000000002";
const instance = "00000000-0000-4000-8000-000000000011";

describe.skipIf(!url)("X reply reservations (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 8, onnotice: () => {} });
    const db = (await sql<{ db: string }[]>`select current_database() as db`)[0]?.db;
    if (!db?.endsWith("_x_reply_claims_test"))
      throw new Error(`refusing to reset non-dedicated database ${db}`);
    await sql`drop schema if exists noelle cascade`;
    await sql.unsafe(
      "do $$ begin if not exists (select from pg_roles where rolname='noelle_app') then create role noelle_app nologin; end if; end $$",
    );
    for (const file of [
      "0001_noelle_schema.sql",
      "0004_drafts_sent_at.sql",
      "0003_x_watchlist.sql",
      "0005_leads_full_schema.sql",
      "0018_x_watchlist_people.sql",
      "0083_x_activity.sql",
      "0108_x_browser_discovery.sql",
      "0112_x_reply_claim_release.sql",
    ])
      await sql.unsafe(readFileSync(resolve(root, "infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.x_reply_claims, noelle.x_activity, noelle.approvals, noelle.drafts, noelle.leads, noelle.agent_instances, noelle.organizations cascade`;
    await sql`insert into noelle.organizations (id,slug,name) values (${org},'one','One'),(${otherOrg},'two','Two')`;
    await sql`insert into noelle.agent_instances (id,org_id,role) values (${instance},${org},'x_intern')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  async function draft(status = "pending", target = "101") {
    const [lead] = await sql<
      { id: string }[]
    >`insert into noelle.leads (org_id,agent_instance_id,external_id,platform,payload) values (${org},${instance},${target},'x','{}') returning id`;
    const [d] = await sql<
      { id: string }[]
    >`insert into noelle.drafts (org_id,lead_id,payload) values (${org},${lead!.id},'{"kind":"reply","body":"supported reply"}') returning id`;
    const [a] = await sql<
      { id: string }[]
    >`insert into noelle.approvals (org_id,agent_instance_id,draft_id,lead_id,status) values (${org},${instance},${d!.id},${lead!.id},${status}) returning id`;
    return { draftId: d!.id, leadId: lead!.id, approvalId: a!.id, targetTweetId: target };
  }

  it("allows exactly one concurrent dispatch reservation across manual and worker candidates", async () => {
    const d = await draft("sent");
    const [manual] = await sql<
      { id: string }[]
    >`insert into noelle.drafts (org_id,lead_id,payload) values (${org},${d.leadId},'{"body":"manual angle"}') returning id`;
    await sql`insert into noelle.approvals (org_id,agent_instance_id,draft_id,lead_id,status) values (${org},${instance},${manual!.id},${d.leadId},'pending')`;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        reserveXReplyClaim(sql, {
          orgId: org,
          targetTweetId: d.targetTweetId,
          draftId: i % 2 ? manual!.id : d.draftId,
          mode: i % 2 ? "manual" : "worker",
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "manual" })).toBeNull();
    expect(await sql`select * from noelle.x_reply_claims`).toHaveLength(1);
  });

  it.each(["pending", "deferred", "errored"])(
    "permits a deliberate manual %s send but not autonomous dispatch",
    async (status) => {
      const d = await draft(status);
      expect(await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "worker" })).toBeNull();
      expect(await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "manual" })).toMatchObject({
        approvalId: d.approvalId,
      });
    },
  );

  it("rejects cross-tenant, wrong target, mismatched lead and wrong-role candidates", async () => {
    const d = await draft();
    expect(await reserveXReplyClaim(sql, { orgId: otherOrg, ...d, mode: "manual" })).toBeNull();
    expect(
      await reserveXReplyClaim(sql, { orgId: org, ...d, targetTweetId: "999", mode: "manual" }),
    ).toBeNull();
    await sql`update noelle.agent_instances set role='cmo' where id=${instance}`;
    expect(await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "manual" })).toBeNull();
    await sql`update noelle.agent_instances set role='x_intern' where id=${instance}`;
    const other = await draft("pending", "102");
    await sql`update noelle.approvals set lead_id=${other.leadId} where id=${d.approvalId}`;
    expect(await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "manual" })).toBeNull();
  });

  it.each(["reply", "skip"])("withholds a target with durable %s activity", async (type) => {
    const d = await draft();
    await sql`insert into noelle.x_activity (org_id,session_id,type,tweet_id) values (${org},gen_random_uuid(),${type},${d.targetTweetId})`;
    expect(await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "manual" })).toBeNull();
  });

  it("withholds confirmed receipts but permits a limbo sibling until the unique target claim wins", async () => {
    const d = await draft("sent");
    const [sibling] = await sql<
      { id: string }[]
    >`insert into noelle.drafts (org_id,lead_id,payload) values (${org},${d.leadId},'{"body":"other angle"}') returning id`;
    await sql`insert into noelle.approvals (org_id,agent_instance_id,draft_id,lead_id,status) values (${org},${instance},${sibling!.id},${d.leadId},'sent')`;
    await sql`update noelle.drafts set sent_at=now() where id=${sibling!.id}`;
    expect(await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "worker" })).toBeNull();
    await sql`update noelle.drafts set sent_at=null where id=${sibling!.id}`;
    expect(await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "worker" })).not.toBeNull();
    expect(
      await reserveXReplyClaim(sql, {
        orgId: org,
        draftId: sibling!.id,
        targetTweetId: "101",
        mode: "worker",
      }),
    ).toBeNull();
  });

  it("scopes release to the exact approval and keeps confirmed claims permanently", async () => {
    const d = await draft();
    const claim = (await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "manual" }))!;
    expect(await releaseXReplyClaim(sql, { ...claim, orgId: otherOrg })).toBe(false);
    expect(await releaseXReplyClaim(sql, { ...claim, approvalId: instance })).toBe(false);
    await sql`update noelle.drafts set sent_external_id='201' where id=${d.draftId}`;
    expect(await releaseXReplyClaim(sql, claim)).toBe(false);
    await sql`update noelle.drafts set sent_external_id=null where id=${d.draftId}`;
    expect(await releaseXReplyClaim(sql, claim)).toBe(true);
    expect(await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "manual" })).not.toBeNull();
  });

  it("allows the application role only the scoped release, without direct DELETE privilege", async () => {
    const d = await draft();
    const claim = (await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "manual" }))!;
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role noelle_app`;
        await tx`delete from noelle.x_reply_claims`;
      }),
    ).rejects.toThrow(/permission denied/);
    expect(
      await sql.begin(async (tx) => {
        await tx`set local role noelle_app`;
        return releaseXReplyClaim(tx as unknown as typeof sql, claim);
      }),
    ).toBe(true);
  });
  it("rechecks semantic review when an auto-claimed reply reaches dispatch", async () => {
    const d = await draft("sent");
    await sql`update noelle.approvals set decided_by='auto-send' where id=${d.approvalId}`;
    expect(await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "worker" })).toBeNull();
    await sql`update noelle.drafts set payload=payload||'{"verifier_meta":{"pass":true,"judgeOk":true}}' where id=${d.draftId}`;
    expect(await reserveXReplyClaim(sql, { orgId: org, ...d, mode: "worker" })).not.toBeNull();
  });

  it.each(["review edit", "approval skip"] as const)("waits for a concurrent %s before reserving dispatch", async (change) => {
    const d = await draft(change === "review edit" ? "sent" : "pending");
    await sql`update noelle.drafts set payload=payload||'{"verifier_meta":{"pass":true,"judgeOk":true}}' where id=${d.draftId}`;
    await sql`update noelle.approvals set decided_by='auto-send' where id=${d.approvalId}`;
    let reservation: ReturnType<typeof reserveXReplyClaim> | undefined;
    let settled = false;
    await sql.begin(async (tx) => {
      await tx`select id from noelle.drafts where id=${d.draftId} for update`;
      if (change === "review edit") await tx`update noelle.drafts set payload=payload-'verifier_meta' where id=${d.draftId}`;
      else await tx`update noelle.approvals set status='skipped' where id=${d.approvalId}`;
      reservation = reserveXReplyClaim(sql, { orgId: org, ...d, mode: change === "review edit" ? "worker" : "manual" });
      void reservation.then(() => { settled = true; });
      // Commit once the competing reservation has either made its decision or
      // reached the draft lock. This observes PostgreSQL rather than assuming a delay.
      for (let attempt = 0; attempt < 100; attempt++) {
        const [state] = await sql<{ waiting: boolean }[]>`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%noelle.drafts%') as waiting`;
        if (settled || state?.waiting) return;
        await new Promise((resolve) => setTimeout(resolve,10));
      }
      throw new Error("reservation did not reach a decision or row lock");
    });
    expect(await reservation).toBeNull();
    expect(await sql`select * from noelle.x_reply_claims`).toHaveLength(0);
  });

  it("matches the semantic review contract for missing, false, invalid and passing records", async () => {
    for (const review of [null, {}, { pass: true }, { pass: false, judgeOk: true }, { pass: "true", judgeOk: true }, { pass: true, judgeOk: true }]) {
      const [row] = await sql<{ ready: boolean | null }[]>`select ${unattendedReplyReviewSql(sql, sql`${sql.json({ verifier_meta: review })}::jsonb`)} as ready`;
      expect(row?.ready === true).toBe(passesUnattendedReplyReview(review));
    }
    for (const approved of [null, false, true]) {
      const [row] = await sql<{ ready: boolean | null }[]>`select ${unattendedReplyReviewSql(sql, sql`${sql.json({ verifier_meta: { pass: true, judgeOk: true }, human_review_required: true, human_send_approved: approved })}::jsonb`)} as ready`;

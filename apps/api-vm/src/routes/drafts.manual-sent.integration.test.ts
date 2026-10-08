import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import type { AuthContext } from "../middleware/jwt.js";
import { drafts } from "./drafts.js";

vi.mock("../lib/auth.js", () => ({ isOrgMember: vi.fn(async () => true) }));
const url = process.env.NOELLE_X_MANUAL_SENT_TEST_DATABASE_URL;
const org = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000011";
const user = "00000000-0000-4000-8000-000000000021";
const app = new Hono<{ Variables: { auth: AuthContext } }>();
app.use("*", async (c, next) => { c.set("auth", { userId: user, raw: {} }); await next(); });
app.route("/", drafts);

describe.skipIf(!url)("manual-send undo (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    const db = (await sql<{ db: string }[]>`select current_database() as db`)[0]?.db;
    if (!db?.endsWith("_x_manual_sent_test")) { await sql.end(); throw new Error(`refusing to reset non-dedicated database ${db}`); }
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0004_drafts_sent_at.sql", "0003_x_watchlist.sql", "0005_leads_full_schema.sql", "0015_auto_send.sql", "0026_auto_defer_dms.sql", "0018_x_watchlist_people.sql", "0107_linkedin_reply_claims.sql", "0108_x_browser_discovery.sql", "0125_reddit_reply_claims.sql"])
      await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    __setDbClientForTests(sql);
    await sql`truncate noelle.approvals, noelle.drafts, noelle.leads, noelle.agent_instances, noelle.organizations cascade`;
    await sql`insert into noelle.organizations (id,slug,name) values (${org},'one','One')`;
    await sql`insert into noelle.agent_instances (id,org_id,role) values (${instance},${org},'x_intern')`;
  });
  afterAll(async () => { resetDbClientForTests(); await sql?.end(); });
  async function approval(leadId?: string, receipt: string | null = "manual:fixture", status = "sent", decidedAt = "2026-01-01T12:00:00Z") {
    if (!leadId) {
      const [lead] = await sql<{ id: string }[]>`insert into noelle.leads (org_id,agent_instance_id,external_id,platform,status,payload)
        values (${org},${instance},gen_random_uuid()::text,'x','drafted','{}') returning id`;
      leadId = lead!.id;
    }
    const [draft] = await sql<{ id: string }[]>`insert into noelle.drafts (org_id,lead_id,sent_external_id,posted_at,payload)
      values (${org},${leadId},${receipt},now(),'{}') returning id`;
    const [row] = await sql<{ id: string }[]>`insert into noelle.approvals (org_id,agent_instance_id,draft_id,lead_id,status,decided_at,skip_reason)
      values (${org},${instance},${draft!.id},${leadId},${status},${decidedAt},${status === 'skipped' ? 'sibling-angle-sent' : null}) returning id`;
    return { id: row!.id, leadId, draftId: draft!.id };
  }
  async function undo(id: string) {
    const response = await app.request(`/api/drafts/${id}/unmark-sent`, { method: "POST" });
    return { status: response.status, body: await response.json() as { restored: number; error?: string } };
  }
  async function state(row: { id: string; draftId: string }) {
    return (await sql<{ status: string; receipt: string | null }[]>`select a.status,d.sent_external_id as receipt from noelle.approvals a join noelle.drafts d on d.id=a.draft_id where a.id=${row.id}`)[0];
  }
  async function mark(id: string, tweetUrl?: string) {
    const response = await app.request(`/api/drafts/${id}/mark-sent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tweet_url: tweetUrl }) });
    return { status: response.status, body: await response.json() as { sent_url?: string | null; sent_at?: string; error?: string } };
  }
  it("records a manual send without posting and preserves its real URL on retry", async () => {
    const row = await approval(undefined, null, "pending");
    const link = "https://x.com/example/status/1987654321000000000";
    const first = await mark(row.id, link);
    expect(first.status).toBe(200);
    expect((await state(row))?.receipt).toBe("1987654321000000000");
    const repeated = await mark(row.id, link);
    expect(repeated).toMatchObject({ status: 200, body: { sent_url: link, sent_at: first.body.sent_at } });
  });
  it.each(["https://evilx.com/example/status/1987654321000000000", "https://x.com/example/status/0", "https://x.com/example/status/"+"9".repeat(26)])("rejects an unusable platform receipt URL: %s", async (link) => {
    const row = await approval(undefined, null, "pending");
    expect((await mark(row.id, link)).status).toBe(400);
    expect(await state(row)).toEqual({ status: "pending", receipt: null });
  });
  it("does not echo an in-flight worker claim as a confirmed manual send", async () => {
    const row = await approval(undefined, null);
    expect((await mark(row.id)).status).toBe(409);
    expect((await state(row))?.receipt).toBeNull();
  });
  it("rejects a skipped decision committed before the manual-record transaction starts", async () => {
    const row = await approval(undefined, null, "pending");
    let injected = false;
    __setDbClientForTests(new Proxy(sql, { get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) => {
        if (!injected) { injected = true; await sql`update noelle.approvals set status='skipped' where id=${row.id}`; }
        return sql.begin(fn);
      };
    } }));
    expect((await mark(row.id)).status).toBe(409);
    expect(await state(row)).toEqual({ status: "skipped", receipt: null });
  });
  it("undoes a manual sentinel and permits a repeated undo", async () => {
    const row = await approval();
    expect((await undo(row.id)).status).toBe(200);
    expect(await state(row)).toEqual({ status: "pending", receipt: null });
    expect((await undo(row.id)).status).toBe(200);
  });
  it("refuses an actual platform receipt", async () => {
    const row = await approval(undefined, "1987654321000000000");
    expect((await undo(row.id)).status).toBe(409);
    expect((await state(row))?.status).toBe("sent");
  });
  it("does not mistake an in-flight sent approval without a receipt for a manual record", async () => {
    const row = await approval(undefined, null);
    expect((await undo(row.id)).status).toBe(409);
    expect((await state(row))?.status).toBe("sent");
  });
  it("preserves a platform receipt committed between the authorization read and transaction", async () => {
    const row = await approval();
    let injected = false;
    __setDbClientForTests(new Proxy(sql, { get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) => {
        if (!injected) { injected = true; await sql`update noelle.drafts set sent_external_id='1987654321000000000',sent_at=now() where id=${row.draftId}`; }
        return sql.begin(fn);
      };
    } }));
    expect((await undo(row.id)).status).toBe(409);
    expect(await state(row)).toEqual({ status: "sent", receipt: "1987654321000000000" });
  });
  it("restores only sibling decisions made by the same manual record", async () => {
    const row = await approval();
    const same = await approval(row.leadId, null, "skipped");
    const earlier = await approval(row.leadId, null, "skipped", "2025-12-31T12:00:00Z");
    expect((await undo(row.id)).body.restored).toBe(1);
    expect((await state(same))?.status).toBe("pending");
    expect((await state(earlier))?.status).toBe("skipped");
  });
  it("keeps a target with an outstanding X write claim out of the queue", async () => {
    const row = await approval();
    await sql`insert into noelle.x_reply_claims (org_id,tweet_id,approval_id) values (${org},'1987654321000000000',${row.id})`;
    expect((await undo(row.id)).status).toBe(409);
    expect((await state(row))?.status).toBe("sent");
  });
  it("keeps a browser-confirmed LinkedIn claim out of the manual undo queue", async () => {
    const row = await approval();
    await sql`insert into noelle.linkedin_reply_claims (org_id,activity_urn,approval_id,status) values (${org},'urn:li:activity:1987654321000000000',${row.id},'sent')`;
    expect((await undo(row.id)).status).toBe(409);
    expect((await state(row))?.status).toBe("sent");
  });
  it("does not clear a confirmed send timestamp behind a manual sentinel", async () => {
    const row = await approval();
    await sql`update noelle.drafts set sent_at=now() where id=${row.draftId}`;
    expect((await undo(row.id)).status).toBe(409);
    expect((await state(row))?.receipt).toBe("manual:fixture");
  });
});

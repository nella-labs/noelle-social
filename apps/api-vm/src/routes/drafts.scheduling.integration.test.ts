import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import type { AuthContext } from "../middleware/jwt.js";
import { drafts } from "./drafts.js";

vi.mock("../lib/auth.js", () => ({ isOrgMember: vi.fn(async () => true) }));
const url = process.env.NOELLE_X_SCHEDULING_TEST_DATABASE_URL;
const org = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000011";
const second = "00000000-0000-4000-8000-000000000012";
const user = "00000000-0000-4000-8000-000000000021";
const app = new Hono<{ Variables: { auth: AuthContext } }>();
app.use("*", async (c, next) => { c.set("auth", { userId: user, raw: {} }); await next(); });
app.route("/", drafts);

describe.skipIf(!url)("X automatic-send scheduling (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 8, onnotice: () => {} });
    const db = (await sql<{ db: string }[]>`select current_database() as db`)[0]?.db;
    if (!db?.endsWith("_x_scheduling_test")) throw new Error(`refusing to reset non-dedicated database ${db}`);
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0004_drafts_sent_at.sql", "0003_x_watchlist.sql", "0005_leads_full_schema.sql", "0015_auto_send.sql", "0081_reply_send_enabled.sql"])
      await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema", file), "utf8"));
    __setDbClientForTests(sql);
  });
  beforeEach(async () => {
    vi.stubEnv("NOELLE_AUTOSEND_MAX_PER_DAY", "3");
    vi.stubEnv("NOELLE_AUTOSEND_REQUIRE_SEND_ENABLED", "false");
    vi.stubEnv("NOELLE_AUTOSEND_QUIET_START_UTC", "0");
    vi.stubEnv("NOELLE_AUTOSEND_QUIET_END_UTC", "0");
    await sql`truncate noelle.approvals, noelle.drafts, noelle.leads, noelle.agent_instances, noelle.organizations cascade`;
    await sql`insert into noelle.organizations (id,slug,name) values (${org},'one','One')`;
    await sql`insert into noelle.agent_instances (id,org_id,role,reply_send_enabled) values
      (${instance},${org},'x_intern',true),(${second},${org},'linkedin_intern',true)`;
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { resetDbClientForTests(); await sql?.end(); });

  async function approval(owner = instance, leadId?: string, verified = true) {
    if (!leadId) {
      const [lead] = await sql<{ id: string }[]>`insert into noelle.leads (org_id,agent_instance_id,external_id,platform,status,payload)
        values (${org},${owner},gen_random_uuid()::text,${owner === second ? 'linkedin' : 'x'},'drafted','{}') returning id`;
      leadId = lead!.id;
    }
    const [draft] = await sql<{ id: string }[]>`insert into noelle.drafts (org_id,lead_id,payload)
      values (${org},${leadId},${sql.json({ kind: "reply", body: "a supported reply", verifier_meta: { pass: verified, judgeOk: verified } })}) returning id`;
    const [row] = await sql<{ id: string }[]>`insert into noelle.approvals (org_id,agent_instance_id,draft_id,lead_id,status)
      values (${org},${owner},${draft!.id},${leadId},'pending') returning id`;
    return { id: row!.id, leadId };
  }
  async function queue(ids: string[]) {
    const response = await app.request("/api/drafts/schedule-auto-send", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org_id: org, approval_ids: ids }) });
    return { status: response.status, body: await response.json() as { count: number; withheld: number; scheduled: { approval_id: string; target_at: string }[]; error?: string } };
  }

  it("reports only the selected angle that was actually scheduled for a lead", async () => {
    const first = await approval();
    const sibling = await approval(instance, first.leadId);
    const result = await queue([first.id, sibling.id]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ count: 1, scheduled: [{ approval_id: first.id }], withheld: 1 });
    expect((await sql<{ status: string; target: Date | null }[]>`select status,auto_send_target_at as target from noelle.approvals where id=${sibling.id}`)[0]).toEqual({ status: "skipped", target: null });
  });

  it("keeps eight concurrent requests within one shared instance cap", async () => {
    const batches = await Promise.all(Array.from({ length: 8 }, async () => Promise.all(Array.from({ length: 3 }, () => approval()))));
    const results = await Promise.all(batches.map((batch) => queue(batch.map((row) => row.id))));
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(results.reduce((count, result) => count + result.body.count, 0)).toBe(3);
    expect((await sql<{ count: number }[]>`select count(*)::int as count from noelle.approvals where status='pending' and auto_send_target_at is not null`)[0]?.count).toBe(3);
  });

  it("does not stamp another platform's replies into the X API send queue", async () => {
    const first = await approval();
    const other = await approval(second);
    expect((await queue([first.id, other.id])).body.count).toBe(1);
    expect((await sql<{ target: Date | null }[]>`select auto_send_target_at as target from noelle.approvals where id=${other.id}`)[0]?.target).toBeNull();
  });

  it("checks the X sending switch even if another platform's selection appears first", async () => {
    vi.stubEnv("NOELLE_AUTOSEND_REQUIRE_SEND_ENABLED", "true");
    await sql`update noelle.agent_instances set reply_send_enabled=false where id=${instance}`;
    const other = await approval(second);
    const first = await approval();
    expect(await queue([other.id, first.id])).toMatchObject({ status: 409, body: { error: "sending_disabled" } });
    expect((await sql<{ count: number }[]>`select count(*)::int as count from noelle.approvals where auto_send_target_at is not null`)[0]?.count).toBe(0);
  });

  it("appends later batches after an existing scheduled reply", async () => {
    const existing = await approval();
    const [row] = await sql<{ at: Date }[]>`update noelle.approvals set auto_send_target_at=now()+interval '2 hours' where id=${existing.id} returning auto_send_target_at as at`;
    const next = await approval();
    const result = await queue([next.id]);
    expect(result.body.count).toBe(1);
    expect(new Date(result.body.scheduled[0]!.target_at).getTime()).toBeGreaterThan(row!.at.getTime());
  });

  it("withholds a draft whose review failed", async () => {
    const failed = await approval(instance, undefined, false);
    expect((await queue([failed.id])).body).toMatchObject({ count: 0, withheld: 1 });
    expect((await sql<{ target: Date | null }[]>`select auto_send_target_at as target from noelle.approvals where id=${failed.id}`)[0]?.target).toBeNull();
  });
});

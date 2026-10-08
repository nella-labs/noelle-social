import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import postgres from "postgres";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import type { AuthContext } from "../middleware/jwt.js";
import { drafts } from "./drafts.js";

export const stateOrg = "00000000-0000-4000-8000-000000000001";
export const stateForeignOrg = "00000000-0000-4000-8000-000000000002";
export const stateInstance = "00000000-0000-4000-8000-000000000011";
export const stateForeignInstance = "00000000-0000-4000-8000-000000000012";
const app = new Hono<{ Variables: { auth: AuthContext } }>();
app.use("*", async (c, next) => { c.set("auth", { userId: stateOrg, raw: {} }); await next(); });
app.route("/", drafts);

export async function openApprovalStateFixture(url: string) {
  const sql = postgres(url, { max: 12, onnotice: () => {} });
  const [db] = await sql`select current_database() as name`;
  if (!db?.name.endsWith("_approval_state_test")) {
    await sql.end(); throw new Error("Dedicated approval state test database required");
  }
  await sql`drop schema if exists noelle cascade`;
  for (const file of ["0001_noelle_schema.sql", "0004_drafts_sent_at.sql", "0003_x_watchlist.sql",
    "0005_leads_full_schema.sql", "0018_x_watchlist_people.sql", "0083_x_activity.sql", "0107_linkedin_reply_claims.sql", "0108_x_browser_discovery.sql", "0125_reddit_reply_claims.sql"])
    await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${file}`, import.meta.url), "utf8"));
  __setDbClientForTests(sql);
  return {
    sql,
    async reset() {
      __setDbClientForTests(sql); await sql`truncate noelle.organizations cascade`;
      await sql`insert into noelle.organizations(id,slug,name) values (${stateOrg},'one','One'),(${stateForeignOrg},'two','Two')`;
      await sql`insert into noelle.agent_instances(id,org_id,role,status) values
        (${stateInstance},${stateOrg},'x_intern','active'),(${stateForeignInstance},${stateForeignOrg},'x_intern','active')`;
    },
    async seed(kind = "reply", status = "pending", leadId?: string, orgId = stateOrg, instanceId = stateInstance) {
      if (!leadId) {
        const [lead] = await sql`insert into noelle.leads(org_id,agent_instance_id,external_id,platform,status,payload)
          values (${orgId},${instanceId},gen_random_uuid()::text,'x','drafted','{}') returning id`;
        leadId = lead!.id as string;
      }
      const [draft] = await sql`insert into noelle.drafts(org_id,lead_id,payload)
        values (${orgId},${leadId},${sql.json({ kind, body: "Original", verifier_meta: { pass: true }, reply_recheck: { pass: true } })}) returning id`;
      const [approval] = await sql`insert into noelle.approvals(org_id,agent_instance_id,draft_id,lead_id,status,decided_by)
        values (${orgId},${instanceId},${draft!.id},${leadId},${status},'operator') returning id`;
      return { id: approval!.id as string, draftId: draft!.id as string, leadId };
    },
    request(id: string, action: string, body: object = {}) {
      return app.request(`/api/drafts/${id}${action ? `/${action}` : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    },
    async state(row: { id: string; draftId: string }) {
      const [state] = await sql`select a.status,d.payload,d.sent_external_id as receipt from noelle.approvals a
        join noelle.drafts d on d.id=a.draft_id where a.id=${row.id}`;
      return state;
    },
    async close() { resetDbClientForTests(); await sql.end(); },
  };
}

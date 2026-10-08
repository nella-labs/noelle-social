import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type JSONValue } from "postgres";

export const profilingOrg = "00000000-0000-4000-8000-000000000001";
export const profilingForeignOrg = "00000000-0000-4000-8000-000000000002";
export const profilingInstance = "00000000-0000-4000-8000-000000000011";

export async function openProfilingFixture(url: string) {
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  const [database] = await sql`select current_database() as name`;
  if (!database?.name.endsWith("_x_profiling_test")) {
    await sql.end();
    throw new Error("Dedicated X profiling test database required");
  }
  await sql`drop schema if exists noelle cascade`;
  for (const file of [
    "0001_noelle_schema.sql",
    "0004_drafts_sent_at.sql",
    "0003_x_watchlist.sql",
    "0005_leads_full_schema.sql",
    "0018_x_watchlist_people.sql",
    "0020_x_watchlist_profiles.sql",
    "0048_watchlist_playbooks.sql",
  ]) {
    await sql.unsafe(
      await readFile(new URL(`../../../../infra/cloudsql/schema/${file}`, import.meta.url), "utf8"),
    );
  }
  return {
    sql,
    async reset() {
      await sql`truncate noelle.organizations cascade`;
      await sql`insert into noelle.organizations(id,slug,name) values
        (${profilingOrg},'one','One'),(${profilingForeignOrg},'two','Two')`;
      await sql`insert into noelle.agent_instances(id,org_id,role,status)
        values (${profilingInstance},${profilingOrg},'x_intern','paused')`;
    },
    async watch(handle: string, orgId = profilingOrg) {
      await sql`insert into noelle.x_watchlist_people(org_id,agent_instance_id,handle)
        values (${orgId},${profilingInstance},${handle})`;
    },
    async lead(handle: string, payload: Record<string, unknown> = {}, orgId = profilingOrg) {
      const id = randomUUID();
      await sql`insert into noelle.leads(id,external_id,org_id,agent_instance_id,author_handle,payload)
        values (${id},${id},${orgId},${profilingInstance},${handle},
          ${sql.json({ text: "A saved source post", ...payload } as JSONValue)})`;
      return id;
    },
    async sent(
      handle: string,
      options: {
        kind?: string | null;
        confirmed?: boolean;
        approvalOrg?: string;
        draftOrg?: string;
        leadOrg?: string;
        approvalLead?: string;
        sentDaysAgo?: number;
        receiptOnly?: boolean;
      } = {},
    ) {
      const leadId = await this.lead(handle, {}, options.leadOrg);
      const draftId = randomUUID();
      const kind = options.kind === undefined ? "reply" : options.kind;
      const payload = kind === null ? { body: "A reply" } : { kind, body: "A reply" };
      await sql`insert into noelle.drafts(id,lead_id,org_id,payload,sent_at,sent_external_id)
        values (${draftId},${leadId},${options.draftOrg ?? profilingOrg},${sql.json(payload)},
          ${options.confirmed === false || options.receiptOnly ? null : new Date(Date.now() - (options.sentDaysAgo ?? 0) * 86400000)},
          ${options.receiptOnly ? "12345" : null})`;
      await sql`insert into noelle.approvals(org_id,agent_instance_id,draft_id,lead_id,status,decided_at)
        values (${options.approvalOrg ?? profilingOrg},${profilingInstance},${draftId},
          ${options.approvalLead ?? leadId},'sent',now())`;
      return { leadId, draftId };
    },
    close: () => sql.end(),
  };
}

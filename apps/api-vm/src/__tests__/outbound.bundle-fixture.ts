import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { createApp } from "../app.js";
import { resetEnvForTests } from "../env.js";
import { signHmacBody } from "../middleware/hmac.js";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import type { OutboundIn } from "@noelle/contracts";

export const url = process.env.NOELLE_OUTBOUND_BUNDLE_TEST_DATABASE_URL;
export const org = "00000000-0000-4000-8000-000000000001";
export const foreignOrg = "00000000-0000-4000-8000-000000000002";
export const instance = "00000000-0000-4000-8000-000000000011";
const secret = "outbound-bundle-fixture-secret".repeat(3);
export async function setup(): Promise<Sql> {
  const sql = postgres(url!, { max: 6, onnotice: () => {} });
  const [db] = await sql`select current_database() as db`;
  if (db?.db !== "noelle_outbound_bundle_test") throw Error("Dedicated outbound bundle database required");
  await sql`drop schema if exists noelle cascade`;
  for (const name of ["0001_noelle_schema.sql", "0005_leads_full_schema.sql", "0106_tenant_scoped_lead_identity.sql"])
    await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
  process.env.NODE_ENV = "test"; process.env.NOELLE_DATABASE_URL = url;
  process.env.NOELLE_SUPABASE_JWT_SECRET = "outbound-fixture-jwt"; process.env.NOELLE_HMAC_SECRET = secret;
  delete process.env.NOELLE_APP_BASE_URL; resetEnvForTests();
  return sql;
}
export async function reset(sql: Sql) {
  await sql`drop trigger if exists fixture_reject on noelle.drafts`;
  await sql`drop trigger if exists fixture_reject on noelle.approvals`;
  await sql`truncate noelle.organizations cascade`;
  await sql`insert into noelle.organizations(id,slug,name) values (${org},'bundle','Bundle'),(${foreignOrg},'foreign','Foreign')`;
  await sql`insert into noelle.agent_instances(id,org_id,role) values (${instance},${org},'x_intern')`;
  __setDbClientForTests(sql);
}
export async function close(sql: Sql) { resetDbClientForTests(); await sql?.end({ timeout: 1 }); }
export function payload(overrides: Partial<OutboundIn> = {}): OutboundIn {
  return { owner: { orgId: org, agentInstanceId: instance }, leadId: "source-post", batchNumber: null,
    platform: "x", authorHandle: "source_author", authorId: "123", authorFollowers: null, allowsDms: null,
    originalPostId: "1234567890123456789", originalPostText: "measured source details",
    originalPostUrl: "https://x.com/source_author/status/1234567890123456789", postedAt: null, matchedTrigger: null,
    drafts: [{ id: crypto.randomUUID(), kind: "reply", angle: "technical", body: "concrete useful detail", charCount: 22 }],
    verifierMeta: { pass: true, judgeOk: true, scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 1 }, attempts: 0, reasons: [] },
    ...overrides };
}
export async function post(body: OutboundIn) {
  const json = JSON.stringify(body), ts = Math.floor(Date.now() / 1000);
  const { signature } = signHmacBody(secret, ts, json);
  return createApp().request("/api/outbound", { method: "POST", body: json,
    headers: { "content-type": "application/json", "x-noelle-timestamp": String(ts), "x-noelle-signature": signature } });
}
export async function counts(sql: Sql) {
  const [r] = await sql`select (select count(*)::int from noelle.leads) as leads,
    (select count(*)::int from noelle.drafts) as drafts,(select count(*)::int from noelle.approvals) as approvals`;
  return r;
}
export async function seedLead(sql: Sql, ownerOrg = org, owner: string | null = instance, external = "existing") {
  const [r] = await sql`insert into noelle.leads(org_id,agent_instance_id,external_id,platform,payload)
    values (${ownerOrg},${owner},${external},'x','{}') returning id`;
  return r!.id as string;
}

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import * as owner from "./playbooksDb.js";
export const org = "00000000-0000-4000-8000-000000000001";
export const foreignOrg = "00000000-0000-4000-8000-000000000002";
export const instance = "00000000-0000-4000-8000-000000000011";
export const linkedin = "00000000-0000-4000-8000-000000000012";
export const foreignInstance = "00000000-0000-4000-8000-000000000013";
export const unsupported = "00000000-0000-4000-8000-000000000014";
export let sql: Sql;
export async function setup(url: string) {
  sql = postgres(url, {
    max: 4,
    onnotice: () => {},
    connection: { application_name: "playbooks-native" },
  });
  const [database] = await sql`select current_database() as name`;
  if (!database?.name.endsWith("_playbooks_scope_test")) {
    await sql.end();
    throw new Error("Dedicated playbook database required");
  }
  await sql`drop schema if exists noelle cascade`;
  for (const file of [
    "0001_noelle_schema.sql",
    "0005_leads_full_schema.sql",
    "0048_watchlist_playbooks.sql",
  ])
    await sql.unsafe(
      await readFile(new URL(`../../../infra/cloudsql/schema/${file}`, import.meta.url), "utf8"),
    );
}
export async function reset() {
  await sql`truncate noelle.organizations cascade`;
  await sql`insert into noelle.organizations(id,slug,name) values (${org},'one','One'),(${foreignOrg},'two','Two')`;
  await sql`insert into noelle.agent_instances(id,org_id,role) values
    (${instance},${org},'x_intern'),(${linkedin},${org},'linkedin_intern'),
    (${foreignInstance},${foreignOrg},'x_intern'),(${unsupported},${org},'cmo')`;
}
export async function lead(
  opts: {
    org?: string;
    instance?: string;
    platform?: string;
    author?: string;
    external?: string;
  } = {},
) {
  const external = opts.external ?? randomUUID();
  await sql`insert into noelle.leads(id,external_id,org_id,agent_instance_id,platform,author_handle,payload)
    values (${randomUUID()},${external},${opts.org ?? org},${opts.instance ?? instance},
      ${opts.platform ?? "x"},${opts.author ?? "builder"},'{}')`;
  return external;
}
export function input(
  samplePostIds: string[],
  overrides: Partial<owner.PlaybookUpsert> = {},
): owner.PlaybookUpsert {
  return {
    orgId: org,
    agentInstanceId: instance,
    platform: "x",
    authorHandle: "builder",
    fsdProfileId: null,
    hookPatterns: ["Observed hook"],
    structureNotes: "Observed structure",
    cadenceNotes: "Observed cadence",
    topTopics: ["databases"],
    engagementPercentile: 0.5,
    samplePostIds,
    model: "inert",
    ...overrides,
  };
}
export const write = (p: ReturnType<typeof input>) => owner.upsertPlaybook(sql, p);
export const top = (args: Partial<owner.PlaybookScope> = {}) =>
  owner.getTopPlaybooks(sql, {
    orgId: org,
    platform: "x",
    agentInstanceId: instance,
    limit: 10,
    ...args,
  });
export const fresh = (args: Partial<owner.PlaybookScope> = {}) =>
  owner.getFreshPlaybookAuthors(sql, {
    orgId: org,
    platform: "x",
    agentInstanceId: instance,
    authorHandles: ["builder"],
    staleDays: 14,
    ...args,
  });
export const rows = () =>
  sql`select org_id,agent_instance_id,author_handle,structure_notes,sample_post_ids from noelle.watchlist_playbooks`;

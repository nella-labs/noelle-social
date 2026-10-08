import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import * as owner from "./patternBreakerDb.js";

export const org = "00000000-0000-4000-8000-000000000001";
export const reboundOrg = "00000000-0000-4000-8000-000000000003";
export const foreignOrg = "00000000-0000-4000-8000-000000000002";
export const instance = "00000000-0000-4000-8000-000000000011";
export const linkedin = "00000000-0000-4000-8000-000000000012";
export const foreignInstance = "00000000-0000-4000-8000-000000000013";
export const userId = "00000000-0000-4000-8000-000000000021";
export const scope: owner.PatternScope = {
  orgId: org,
  agentInstanceId: instance,
  role: "x_intern",
};
export const operatorScope = { ...scope, userId };
export let sql: postgres.Sql;
export async function setup(url: string) {
  sql = postgres(url, {
    max: 6,
    onnotice: () => {},
    connection: { application_name: "pattern-native" },
  });
  const [database] = await sql`select current_database() as name`;
  if (
    !database?.name?.endsWith("_pattern_refiner_test") &&
    !database?.name?.endsWith("_pattern_rules_read_test")
  ) {
    await sql.end();
    throw new Error(
      "Dedicated *_pattern_refiner_test or *_pattern_rules_read_test database required",
    );
  }
  await sql`drop schema if exists noelle cascade`;
  for (const file of [
    "0001_noelle_schema.sql",
    "0005_leads_full_schema.sql",
    "0004_drafts_sent_at.sql",
    "0003_x_watchlist.sql",
    "0045_post_ideas.sql",
    "0046_post_drafts.sql",
    "0062_pattern_breaker.sql",
    "0081_pattern_suggestion.sql",
    "0121_pattern_refine_claims.sql",
  ]) {
    await sql.unsafe(
      await readFile(new URL(`../../../infra/cloudsql/schema/${file}`, import.meta.url), "utf8"),
    );
  }
}
export async function reset() {
  await sql`truncate noelle.organizations cascade`;
  await sql`insert into noelle.organizations(id,slug,name) values (${org},'one','One'),(${foreignOrg},'two','Two'),(${reboundOrg},'three','Three')`;
  await sql`insert into noelle.agent_instances(id,org_id,role) values
    (${instance},${org},'x_intern'),(${linkedin},${org},'linkedin_intern'),(${foreignInstance},${foreignOrg},'x_intern')`;
  await sql`insert into noelle.org_members(org_id,user_id) values(${org},${userId})`;
}
export async function rule(
  opts: { org?: string; instance?: string; label?: string; active?: boolean } = {},
) {
  const id = randomUUID();
  await sql`insert into noelle.pattern_rules(id,org_id,agent_instance_id,kind,label,instruction,regex,active)
    values (${id},${opts.org ?? org},${opts.instance ?? instance},'phrase',${opts.label ?? id},
      'Avoid reusing a stock closer', 'stock closer', ${opts.active ?? true})`;
  return id;
}
export async function alert(
  ruleId: string,
  opts: { org?: string; instance?: string; status?: string } = {},
) {
  const id = randomUUID();
  await sql`insert into noelle.pattern_alerts(id,org_id,agent_instance_id,rule_id,pattern_name,description,
    window_size,frequency_count,examples,status)
    values (${id},${opts.org ?? org},${opts.instance ?? instance},${ruleId},'stock closer',
      'Recent replies use a stock closer',10,4,'[]',${opts.status ?? "refining"})`;
  return id;
}
export async function reply(
  opts: {
    org?: string;
    leadOrg?: string;
    leadInstance?: string;
    approvalOrg?: string;
    approvalLead?: string;
    kind?: string | null;
    receipt?: string | null;
    body?: string;
    editedBody?: unknown;
  } = {},
) {
  const leadId = randomUUID();
  const draftId = randomUUID();
  const payload: Record<string, unknown> = {
    body: opts.body ?? "A useful reply with a stock closer",
  };
  if (opts.kind !== null) payload.kind = opts.kind ?? "reply";
  if (opts.editedBody !== undefined) payload.edited_body = opts.editedBody;
  await sql`insert into noelle.leads(id,external_id,org_id,agent_instance_id,platform,payload)
    values (${leadId},${randomUUID()},${opts.leadOrg ?? org},${opts.leadInstance ?? instance},'x','{}')`;
  await sql`insert into noelle.drafts(id,lead_id,org_id,payload,sent_external_id)
    values (${draftId},${leadId},${opts.org ?? org},${sql.json(payload as postgres.JSONValue)},${opts.receipt === undefined ? "confirmed-id" : opts.receipt})`;
  await sql`insert into noelle.approvals(org_id,agent_instance_id,draft_id,lead_id,status,decided_at)
    values (${opts.approvalOrg ?? org},${instance},${draftId},${opts.approvalLead ?? leadId},'sent',now())`;
  return draftId;
}
export async function post(
  opts: {
    org?: string;
    ideaOrg?: string;
    ideaInstance?: string;
    platform?: string;
    ideaPlatform?: string;
  } = {},
) {
  const ideaId = randomUUID();
  const draftId = randomUUID();
  await sql`insert into noelle.post_ideas(id,org_id,agent_instance_id,platform,hook)
    values (${ideaId},${opts.ideaOrg ?? org},${opts.ideaInstance ?? instance},${opts.ideaPlatform ?? "x"},'Useful observation')`;
  await sql`insert into noelle.post_drafts(id,org_id,agent_instance_id,idea_id,platform,body,status)
    values (${draftId},${opts.org ?? org},${instance},${ideaId},${opts.platform ?? "x"},'A specific useful original post','published')`;
  return draftId;
}
export const corpus = () => owner.loadRecentPosts(sql, scope);
export const rules = () => owner.loadActivePatternRules(sql, scope);
export const queue = () => owner.loadRefiningAlerts(sql, scope);
export async function claim(id?: string) {
  const item = (await queue()).find((row) => !id || row.alert_id === id);
  if (!item) throw new Error("Expected eligible request");
  const captured = await owner.claimRefinement(sql, scope, item);
  if (!captured) throw new Error("Expected dispatch claim");
  return captured;
}
export const apply = (
  captured: owner.CapturedPatternClaim,
  instruction: string | null = "Use a concrete detail instead of a stock closer",
) =>
  owner.applyRefinedRule(sql, scope, {
    claim: captured,
    instruction,
    decidedBy: "pattern-breaker",
  });
export async function persist(label = "stock closer", overrides = {}) {
  const posts = await corpus();
  return owner.persistPattern(sql, {
    ...scope,
    corpus: posts,
    windowSize: posts.length,
    finding: {
      label,
      kind: "phrase",
      description: "Recent replies use a stock closer",
      instruction: "Avoid reusing a stock closer",
      regex: "stock closer",
      severity: "medium",
      frequencyCount: posts.length,
      examples: posts.slice(0, 6).map((p) => ({ draftId: p.draftId, snippet: "stock closer" })),
    },
    ...overrides,
  });
}
export async function close(url: string) {
  await sql.end();
  const inspector = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const { vi, expect } = await import("vitest");
    await vi.waitFor(
      async () => {
        const [row] = await inspector`select count(*)::int as remaining from pg_stat_activity
        where datname=current_database() and application_name='pattern-native'`;
        expect(row?.remaining).toBe(0);
      },
      { timeout: 5000 },
    );
  } finally {
    await inspector.end();
  }
}

export async function insertRules(count: number, active = true) {
  await sql`insert into noelle.pattern_rules(org_id,agent_instance_id,kind,label,instruction,active)
      select ${org},${instance},'structure','rule '||n,'Avoid repeating a stock closer',${active}
      from generate_series(1,${count}) n`;
}

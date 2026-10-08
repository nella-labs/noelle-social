import type { Sql } from "postgres";
import {
  PatternExampleSchema,
  PatternFindingSchema,
  UuidSchema,
  PATTERN_ACTIVE_RULE_LIMIT,
  PatternRulesPageInputSchema,
  PatternAlertsPageInputSchema,
  type PatternRulesPageInput,
  type PatternAlertsPageInput,
  type PatternRulesPage,
  type PatternAlertCursor,
  type PatternExample,
  type PatternAlertStatus,
  type PatternAlertView,
} from "@noelle/contracts";
import type { DynamicPattern } from "../drafting/draftVerifier.js";
import { readSourceTimestamp } from "../sourceValues.js";
import { patternCorpusSql } from "./dbCorpus.js";
import {
  patternOwner,
  patternRead,
  validPatternScope,
  PATTERN_ROLES,
  type PatternSql,
  type PatternScope,
  type PatternReadClient,
} from "./dbContext.js";

export interface PatternRuleRow {
  id: string;
  kind: "phrase" | "structure";
  label: string;
  instruction: string;
  suggestion: string | null;
  regex: string | null;
  severity: "low" | "medium" | "high";
  active: boolean;
  source: "auto" | "refined" | "manual";
  created_at: string;
  updated_at: string;
}
export interface PatternAlertRow {
  id: string;
  rule_id: string | null;
  pattern_name: string;
  description: string;
  severity: "low" | "medium" | "high";
  window_size: number;
  frequency_count: number;
  examples: PatternExample[];
  status: PatternAlertStatus;
  rule_instruction: string | null;
  rule_suggestion: string | null;
  refine_note: string | null;
  created_at: string;
  refine_request_id: string | null;
  refine_claim_id: string | null;
}
export interface RefiningAlertRow {
  alert_id: string;
  rule_id: string;
  pattern_name: string;
  description: string;
  current_instruction: string;
  examples: PatternExample[];
  refine_note: string | null;
  refine_request_id: string | null;
  rule_updated_at: string;
  rule_snapshot: string;
}
export interface PatternRefineClaim extends RefiningAlertRow {
  refine_request_id: string;
  refine_claim_id: string;
}
export class PatternRulesHeldError extends Error {
  constructor(readonly reason: "unavailable" | "malformed" | "overflow") {
    super(
      reason === "overflow"
        ? "A complete active rule set exceeds the admitted limit"
        : reason === "malformed"
          ? "Stored pattern rule exceeds the instruction admission contract"
          : "Current pattern owner is unavailable",
    );
    this.name = "PatternRulesHeldError";
  }
}
export interface StoredPatternAlertsPage {
  alerts: PatternAlertRow[];
  nextCursor: PatternAlertCursor | null;
  total: number;
}
function requireScope(scope: PatternScope) {
  if (!validPatternScope(scope)) throw new PatternRulesHeldError("unavailable");
}
function cursorDate(value: string | undefined) {
  if (value !== undefined && readSourceTimestamp(value) === null)
    throw new Error("Invalid pattern page cursor timestamp");
}
function severityRank(sql: PatternSql) {
  return sql`case r.severity when 'high' then 0 when 'medium' then 1 else 2 end`;
}
export function admittedRuleSql(sql: PatternSql) {
  return sql`length(r.label) between 3 and 120 and length(r.instruction) between 8 and 600
    and (r.suggestion is null or length(r.suggestion)<=600)
    and (r.regex is null or length(r.regex)<=300)`;
}
export function admittedAlertSql(sql: PatternSql) {
  return sql`length(a.pattern_name) between 3 and 120 and length(a.description) between 8 and 600
    and a.window_size between 1 and 100 and a.frequency_count between 0 and a.window_size
    and (a.refine_note is null or length(a.refine_note)<=600)
    and case when jsonb_typeof(a.examples)='array' then jsonb_array_length(a.examples)<=6 else false end
    and length(a.examples::text)<=10000
    and not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(a.examples)='array'
      then a.examples else '[]'::jsonb end) e where jsonb_typeof(e)<>'object'
      or jsonb_typeof(e->'snippet') is distinct from 'string' or length(e->>'snippet')>600
      or (e ? 'draftId' and (jsonb_typeof(e->'draftId') is distinct from 'string' or length(e->>'draftId')>100)))`;
}
/** Legacy examples with no source ID are style only; supplied IDs must name a current admitted source. */
export function coherentAlertSources(sql: PatternSql, scope: PatternScope) {
  return sql`not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(a.examples)='array'
    then a.examples else '[]'::jsonb end) e where e ? 'draftId' and not exists(
      select 1 from (${patternCorpusSql(sql, scope)}) corpus
      where corpus.draft_id::text=lower(e->>'draftId')
        and position(regexp_replace(btrim(e->>'snippet'), ${"\\s+"}, ' ', 'g')
          in regexp_replace(btrim(corpus.body), ${"\\s+"}, ' ', 'g'))>0))`;
}
export function scopedRuleJoin(sql: PatternSql) {
  return sql`r.id=a.rule_id and r.org_id=a.org_id and r.agent_instance_id=a.agent_instance_id`;
}
export function ruleFields(sql: PatternSql) {
  return sql`r.id,r.kind,case when length(r.label)<=120 then r.label end as label,
    case when length(r.instruction)<=600 then r.instruction end as instruction,
    case when r.suggestion is null or length(r.suggestion)<=600 then r.suggestion else repeat('x',601) end as suggestion,
    case when r.regex is null or length(r.regex)<=300 then r.regex else repeat('x',301) end as regex,r.severity,r.active,r.source,
    to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
    to_char(r.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`;
}
export function alertFields(sql: PatternSql) {
  return sql`a.id,a.rule_id,a.pattern_name,a.description,a.severity,a.window_size,a.frequency_count,
    a.examples,a.status,case when length(r.instruction)<=600 then r.instruction end as rule_instruction,
    case when length(r.suggestion)<=600 then r.suggestion end as rule_suggestion,
    a.refine_note,to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
    a.refine_request_id,a.refine_claim_id`;
}
export function refiningFields(sql: PatternSql) {
  return sql`a.id as alert_id,a.rule_id,a.pattern_name,a.description,r.instruction as current_instruction,
    a.examples,a.refine_note,a.refine_request_id,r.updated_at::text as rule_updated_at,
    jsonb_build_array(r.kind,r.label,r.instruction,r.suggestion,r.regex,r.severity,r.active,r.source)::text as rule_snapshot`;
}
export function admitRule(row: PatternRuleRow): PatternRuleRow {
  const admitted = PatternFindingSchema.safeParse({
    ...row,
    description: "Stored pattern rule",
    frequencyCount: 0,
    examples: [],
  });
  if (!admitted.success) throw new PatternRulesHeldError("malformed");
  return row;
}
export async function listPatternRules(
  client: Sql | PatternReadClient,
  scope: PatternScope,
  input: PatternRulesPageInput = {},
): Promise<PatternRulesPage> {
  requireScope(scope);
  const { section, limit, cursor } = PatternRulesPageInputSchema.parse(input);
  cursorDate(cursor?.createdAt);
  const rank = cursor ? ["high", "medium", "low"].indexOf(cursor.severity) : 0;
  const rows = await patternRead(
    client,
    async (query, sql) =>
      await query<
        (PatternRuleRow & { total: number; active_count: number; malformed_active: number })[]
      >`
    with owner as materialized (${patternOwner(sql, scope)}), counts as (
      select count(*)::int as total,count(*) filter(where r.active)::int as active_count,
        count(*) filter(where r.active and not (${admittedRuleSql(sql)}))::int as malformed_active
      from noelle.pattern_rules r where r.org_id=${scope.orgId} and r.agent_instance_id=${scope.agentInstanceId})
    select page.*,counts.* from owner cross join counts left join lateral (
      select ${ruleFields(sql)} from noelle.pattern_rules r
      where r.org_id=${scope.orgId} and r.agent_instance_id=${scope.agentInstanceId}
        and (${section}='all' or r.active=(${section}='active'))
        and (${cursor?.id ?? null}::uuid is null or
          (not r.active and ${cursor?.active ?? false}) or
          (r.active=${cursor?.active ?? false} and (${severityRank(sql)}>${rank} or
            (${severityRank(sql)}=${rank} and (r.created_at<${cursor?.createdAt ?? null}::text::timestamptz or
              (r.created_at=${cursor?.createdAt ?? null}::text::timestamptz and r.id>${cursor?.id ?? null}::uuid))))))
      order by r.active desc,${severityRank(sql)},r.created_at desc,r.id limit ${limit + 1}
    ) page on true
    order by page.active desc,case page.severity when 'high' then 0 when 'medium' then 1 else 2 end,
      page.created_at desc,page.id`,
  );
  const context = rows[0];
  if (!context) throw new PatternRulesHeldError("unavailable");
  const selected = rows.filter((row) => row.id !== null);
  const rules = selected.slice(0, limit).map((row) => {
    const { total: _total, active_count: _active, malformed_active: _malformed, ...data } = row;
    try {
      return { ...admitRule(data), admitted: true };

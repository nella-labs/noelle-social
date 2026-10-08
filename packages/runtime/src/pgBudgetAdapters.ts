import type { Sql } from "postgres";
import type { CapAdapters, CapsSnapshot, SpendSnapshot } from "./budgetBucket.js";
import { PgOperationError } from "./boundedPgSession.js";
import { reservePgBudgetAttempt } from "./pgBudgetAdmission.js";
import type { SpendEngine } from "./spendRecorder.js";

/** Subscription calls use their separate pot; provider data fetches use their own billing controls. */
export const CAP_EXEMPT_ENGINES_APIFY: readonly SpendEngine[] = ["apify", "codex-cli"];

/** X API writes remain outside the common model cap. */
export const CAP_EXEMPT_ENGINES_APIFY_XAPI: readonly SpendEngine[] = [
  "apify",
  "xapi",
  "codex-cli",
];

export type PgBudgetAdapterOptions = {
  /**
   * Engines whose spend never counts toward any cap layer. REQUIRED on purpose:
   * a default would let a new call site silently inherit another platform's
   * exemption list, and a cap that starts counting an engine it used to exempt
   * pauses an agent. Pass CAP_EXEMPT_ENGINES_APIFY_XAPI for the X intern,
   * CAP_EXEMPT_ENGINES_APIFY for every other intern.
   *
   * An empty list exempts nothing (`engine <> all('{}')` is true for every row).
   */
  exemptEngines: readonly SpendEngine[];
  /**
   * Window the cap is measured over. Defaults to NOELLE_BUDGET_PERIOD, then to
   * "month" — the historical behaviour, so an unset env changes nothing.
   *
   * Postgres date_trunc('week', …) starts weeks on Monday 00:00.
   */
  period?: BudgetPeriod;
  /** Total admission deadline, including queued and transaction work. First adapter per pool sets it. */
  admissionDeadlineMs?: number;
};

export type BudgetPeriod = "month" | "week";

/**
 * Explicit option wins; then NOELLE_BUDGET_PERIOD; then "month". An
 * unrecognised env value falls back to "month" rather than throwing — a typo in
 * ops config must not take the workers down, and the wider window is the
 * fail-safe direction (it never blocks work that the old behaviour allowed).
 */
export function resolveBudgetPeriod(explicit?: BudgetPeriod): BudgetPeriod {
  if (explicit) return explicit;
  return process.env.NOELLE_BUDGET_PERIOD?.trim() === "week" ? "week" : "month";
}

/** Live period spend and tenant-scoped caps; production calls also acquire durable admission. */
export function createPgBudgetAdapters(sql: Sql, opts: PgBudgetAdapterOptions): CapAdapters {
  // postgres.js serializes a plain array as a Postgres array parameter; copy so a
  // caller's readonly constant is accepted and can't be mutated from under us.
  const exempt = [...opts.exemptEngines];
  // Resolved once per adapter, not per query, so every layer of a single cap
  // check measures the same window.
  const period = resolveBudgetPeriod(opts.period);
  const deadlineMs = Number.isFinite(opts.admissionDeadlineMs) && opts.admissionDeadlineMs! > 0
    ? Math.min(30_000, Math.max(1, Math.floor(opts.admissionDeadlineMs!))) : 2500;
  return {
    reserveAttempt: (args) => reservePgBudgetAttempt(sql, { exempt, period, deadlineMs }, args),
    async fetchSpend(args): Promise<SpendSnapshot> {
      const rows = await sql<
        Array<{
          bucket_cents: number | null;
          org_cents: number | null;
          instance_cents: number | null;
        }>
      >`
        with rollup as (
          select
            coalesce(sum(case when bucket = ${args.bucket} then cents end), 0)::bigint as bucket_cents,
            coalesce(sum(cents), 0)::bigint                                              as org_cents
          from noelle.llm_calls
          where org_id = ${args.orgId}
            and engine <> all(${exempt}::text[])
            and started_at >= date_trunc(${period}, now())
        ),
        instance_spend as (
          select coalesce(sum(cents), 0)::bigint as cents
          from noelle.llm_calls
          where agent_instance_id = ${args.instanceId}
            and org_id = ${args.orgId}
            and engine <> all(${exempt}::text[])
            and started_at >= date_trunc(${period}, now())
        )
        select rollup.bucket_cents,
               rollup.org_cents,
               instance_spend.cents as instance_cents
        from rollup, instance_spend
      `;
      const row = rows[0];
      const bucket = Number(row?.bucket_cents ?? 0);
      const org = Number(row?.org_cents ?? 0);
      const instance = Number(row?.instance_cents ?? 0);
      return { bucket, org, instance };
    },

    /**
     * One engine's spend this period. Deliberately NOT filtered by the exempt
     * list — the whole point is to measure an engine that list excludes.
     */
    async fetchEngineSpend(args: { engine: string; orgId: string }): Promise<number> {
      const rows = await sql<Array<{ cents: number | null }>>`
        select coalesce(sum(cents), 0)::bigint as cents
          from noelle.llm_calls
         where org_id = ${args.orgId}
           and engine = ${args.engine}
           and started_at >= date_trunc(${period}, now())
      `;
      return Number(rows[0]?.cents ?? 0);
    },

    async fetchCaps(args): Promise<CapsSnapshot> {
      const rows = await sql<Array<{ instance_cap: number | null; org_cap_sum: number; paused_until?: Date | string | null }>>`
        select ai.budget_cap_cents as instance_cap,
          (select coalesce(sum(budget_cap_cents),0)::bigint from noelle.agent_instances where org_id=ai.org_id) as org_cap_sum,
          to_jsonb(o)->>'budget_cap_paused_until' as paused_until
        from noelle.agent_instances ai
        join noelle.organizations o on o.id=ai.org_id
        where ai.id=${args.instanceId} and ai.org_id=${args.orgId}
      `;
      const row = rows[0];
      if (!row) throw new PgOperationError("database");

      const pausedRaw = row?.paused_until ?? null;
      const pausedUntil = pausedRaw == null ? null : new Date(pausedRaw);
      // A timestamp in the past is inert, so a forgotten pause expires itself.
      if (pausedUntil && !Number.isNaN(pausedUntil.getTime()) && pausedUntil.getTime() > Date.now()) {
        const open = Number.MAX_SAFE_INTEGER;
        return { bucket: open, org: open, instance: open };
      }
      const instance = row?.instance_cap == null ? Number.MAX_SAFE_INTEGER : Number(row.instance_cap);
      // org_cap_sum can be 0 when the org has rows but no caps; in that
      // case we want "no cap configured", not "0 cents allowed". The
      // dashboard uses the same convention (`hasCap = capCents > 0`).
      const orgSumRaw = Number(row?.org_cap_sum ?? 0);
      const org = orgSumRaw > 0 ? orgSumRaw : Number.MAX_SAFE_INTEGER;
      return { bucket: org, org, instance };
    },
  };
}

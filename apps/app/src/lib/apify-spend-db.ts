import type { Sql } from "postgres";
import type { UsageSnapshot, ApifyLedgerDay } from "./apify-spend-model";

/** Caller must authorize org membership before reading. Both queries are tenant scoped. */
export async function readApifySpendData(sql: Sql, orgId: string) {
  const [saved, recorded] = await Promise.all([
    sql<Array<{
      credential_id: string; label: string; active: boolean; account_id: string;
      cycle_start_at: Date | string; cycle_end_at: Date | string; usage_usd: string | number;
      fetched_at: Date | string; daily_usage: UsageSnapshot["dailyUsage"];
    }>>`
      select u.credential_id, coalesce(c.label, u.label) as label,
             coalesce(c.active, false) as active, u.account_id,
             u.cycle_start_at, u.cycle_end_at, u.usage_usd, u.fetched_at, u.daily_usage
      from noelle.apify_usage_snapshots u
      left join noelle.connections c on c.id = u.credential_id and c.org_id = u.org_id
      where u.org_id = ${orgId}
    `,
    sql<Array<{ credential_id: string | null; label: string | null; active: boolean; day: string; cents: string | number }>>`
      select l.credential_id, c.label, coalesce(c.active, false) as active,
             to_char(l.started_at at time zone 'UTC', 'YYYY-MM-DD') as day,
             sum(l.cents)::numeric as cents
      from noelle.llm_calls l
      left join noelle.connections c on c.id = l.credential_id and c.org_id = l.org_id
      where l.org_id = ${orgId} and l.engine = 'apify'
      group by l.credential_id, c.label, c.active, day
    `,
  ]);
  const iso = (v: Date | string) => new Date(v).toISOString();
  const snapshots: UsageSnapshot[] = saved.map(s => ({
    credentialId: s.credential_id, label: s.label, active: s.active, accountId: s.account_id,
    cycleStartAt: iso(s.cycle_start_at), cycleEndAt: iso(s.cycle_end_at),
    usageUsd: Number(s.usage_usd), fetchedAt: iso(s.fetched_at), dailyUsage: s.daily_usage,
  }));
  const ledger: ApifyLedgerDay[] = recorded.map(l => ({
    credentialId: l.credential_id, label: l.label ?? "Removed / environment token",
    active: l.active, day: l.day, cents: Number(l.cents),
  }));
  return { snapshots, ledger };
}

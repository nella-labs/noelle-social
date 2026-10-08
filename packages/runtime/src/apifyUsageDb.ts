import type { Sql } from "postgres";
import type { ApifyAccountUsageHealth } from "./apifyUsage.js";

export interface ApifyUsageSaveResult {
  saved: boolean;
  reason: "inserted" | "updated" | "not_alive" | "invalid_usage" | "stale_fetch" | "missing_connection";
}
export type ApifyUsageSaveReason = ApifyUsageSaveResult["reason"];
export interface SaveApifyUsageOptions { fetchedAt?: Date }

const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

function validUsage(health: ApifyAccountUsageHealth): boolean {
  if (!health.accountId?.trim() || !amount(health.monthlyUsageUsd)) return false;
  if (!date(health.cycleStartAt) || !date(health.cycleEndAt)) return false;
  if (Date.parse(health.cycleStartAt) >= Date.parse(health.cycleEndAt)) return false;
  if (health.maxMonthlyUsageUsd !== undefined && !amount(health.maxMonthlyUsageUsd)) return false;
  if (health.remainingUsd !== undefined && !amount(health.remainingUsd)) return false;
  if (!Array.isArray(health.dailyUsage)) return false;
  const dates = new Set<string>();
  for (const d of health.dailyUsage) {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !date(d.date) || !amount(d.usageUsd)) return false;
    if (new Date(d.date).toISOString().slice(0, 10) !== d.date || dates.has(d.date)) return false;
    if (d.date < health.cycleStartAt.slice(0, 10) || d.date > health.cycleEndAt.slice(0, 10)) return false;
    dates.add(d.date);
  }
  return true;
}

/** Persist only successful provider readings. Credential rows remain distinct; readers deduplicate accounts. */
export async function saveApifyUsage(
  sql: Sql, orgId: string, credentialId: string, health: ApifyAccountUsageHealth,
  opts: SaveApifyUsageOptions = {},
): Promise<ApifyUsageSaveResult> {
  if (!health.alive) return { saved: false, reason: "not_alive" };
  if (!validUsage(health)) return { saved: false, reason: "invalid_usage" };
  const fetchedAt = opts.fetchedAt ?? new Date(health.fetchedAt ?? Date.now());
  if (!Number.isFinite(fetchedAt.getTime())) return { saved: false, reason: "invalid_usage" };
  const daily = [...health.dailyUsage!].sort((a, b) => a.date.localeCompare(b.date));
  const rows = await sql<{ inserted: boolean }[]>`
    insert into noelle.apify_usage_snapshots
      (org_id, credential_id, label, account_id, cycle_start_at, cycle_end_at,
       usage_usd, max_usage_usd, remaining_usd, fetched_at, daily_usage)
    select c.org_id, c.id, c.label, ${health.accountId!}, ${new Date(health.cycleStartAt!)},
           ${new Date(health.cycleEndAt!)}, ${health.monthlyUsageUsd!},
           ${health.maxMonthlyUsageUsd ?? null}, ${health.remainingUsd ?? null}, ${fetchedAt},
           ${sql.json(daily.map(d => ({ date: d.date, usageUsd: d.usageUsd })))}
    from noelle.connections c
    where c.org_id = ${orgId} and c.id = ${credentialId} and c.kind = 'apify'
    on conflict (org_id, credential_id, cycle_start_at) do update
      set label = excluded.label, account_id = excluded.account_id,
          cycle_end_at = excluded.cycle_end_at, usage_usd = excluded.usage_usd,
          max_usage_usd = excluded.max_usage_usd, remaining_usd = excluded.remaining_usd,
          fetched_at = excluded.fetched_at, daily_usage = excluded.daily_usage, updated_at = now()
      where noelle.apify_usage_snapshots.fetched_at < excluded.fetched_at
    returning (xmax = 0) as inserted
  `;
  if (rows[0]) return { saved: true, reason: rows[0].inserted ? "inserted" : "updated" };
  const exists = await sql`select id from noelle.connections where org_id = ${orgId} and id = ${credentialId} and kind = 'apify'`;
  return { saved: false, reason: exists.length ? "stale_fetch" : "missing_connection" };
}

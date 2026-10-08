import { randomInt } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { ActorReplyCapWriteSchema, type ActorReplyCapState, type ActorReplyCapWrite } from "@noelle/contracts";
import { resolveBrowserReplyCap } from "./browser-reply-cap.js";

type Identity = { orgId: string; instanceId: string };
type Cap = Pick<ActorReplyCapState, "cap" | "configuredCap" | "minimum" | "day">;
type Row = {
  actuator_daily_reply_cap: number | null;
  actuator_daily_reply_cap_min: number | null;
  sampled_day: string | null;
  actuator_daily_reply_cap_effective: number | null;
  today: string;
};

async function limits(tx: TransactionSql): Promise<void> {
  await tx`set local lock_timeout='5s'`;
  await tx`set local statement_timeout='10s'`;
}

async function load(tx: TransactionSql, identity: Identity, lock: boolean): Promise<Row | null> {
  const [row] = await tx<Row[]>`
    select actuator_daily_reply_cap, actuator_daily_reply_cap_min,
      actuator_daily_reply_cap_day::text as sampled_day,
      actuator_daily_reply_cap_effective, current_date::text as today
    from noelle.agent_instances
    where id=${identity.instanceId} and org_id=${identity.orgId} and role='x_intern'
    ${lock ? tx`for update` : tx``}
  `;
  return row ?? null;
}

function active(row: Row): row is Row & { actuator_daily_reply_cap: number; actuator_daily_reply_cap_min: number } {
  if (row.actuator_daily_reply_cap_min == null) return false;
  const cap = row.actuator_daily_reply_cap;
  const min = row.actuator_daily_reply_cap_min;
  if (!Number.isSafeInteger(cap) || cap === null || cap < 0 || cap > 500 ||
      !Number.isSafeInteger(min) || min < 0 || min > cap || !/^\d{4}-\d{2}-\d{2}$/.test(row.today)) {
    throw new Error("Invalid saved X daily reply cap");
  }
  return true;
}

function draw(minimum: number, maximum: number, previous: number | null): number {
  if (minimum === maximum) return minimum;
  if (previous !== null && previous >= minimum && previous <= maximum) {
    const value = randomInt(minimum, maximum);
    return value >= previous ? value + 1 : value;
  }
  return randomInt(minimum, maximum + 1);
}

async function resolveLocked(tx: TransactionSql, identity: Identity, row: Row): Promise<Cap> {
  if (!active(row)) return { cap: resolveBrowserReplyCap("x", row.actuator_daily_reply_cap) };
  const maximum = row.actuator_daily_reply_cap;
  const minimum = row.actuator_daily_reply_cap_min;
  const previous = row.actuator_daily_reply_cap_effective;
  const current = previous !== null && Number.isSafeInteger(previous)
    ? Math.min(maximum, Math.max(minimum, previous)) : maximum;
  const value = row.sampled_day === null ? maximum
    : row.sampled_day === row.today ? current : draw(minimum, maximum, previous);
  if (row.sampled_day !== row.today || previous !== value) {
    await tx`update noelle.agent_instances set actuator_daily_reply_cap_day=${row.today}::date,
      actuator_daily_reply_cap_effective=${value}
      where id=${identity.instanceId} and org_id=${identity.orgId} and role='x_intern'`;
  }
  return { cap: value, configuredCap: maximum, minimum, day: row.today };
}

/** The claim caller already holds the organization lock; reuse that transaction. */
export async function readXBrowserReplyCapInTransaction(tx: TransactionSql, identity: Identity): Promise<Cap | null> {
  await limits(tx);
  const row = await load(tx, identity, true);
  return row ? resolveLocked(tx, identity, row) : null;
}

/** Fixed policies need no row lock; variation resolves one persisted value under lock. */
export async function readXBrowserReplyCap(sql: Sql, identity: Identity): Promise<Cap | null> {
  return sql.begin(async tx => {
    await limits(tx);
    const row = await load(tx, identity, false);
    if (!row) return null;
    if (!active(row)) return { cap: resolveBrowserReplyCap("x", row.actuator_daily_reply_cap) };
    const locked = await load(tx, identity, true);
    return locked ? resolveLocked(tx, identity, locked) : null;
  });
}

/** An omitted minimum is the existing fixed-cap write, including null and zero. */
export async function writeXBrowserReplyCap(
  sql: Sql, identity: Identity, input: ActorReplyCapWrite,
): Promise<Cap | null> {
  const policy = ActorReplyCapWriteSchema.parse(input);
  return sql.begin(async tx => {
    await limits(tx);
    const row = await load(tx, identity, true);
    if (!row) return null;
    const minimum = policy.minimum ?? null;
    let effective: number | null = null;
    let day: string | null = null;
    if (minimum !== null && policy.cap !== null) {
      day = row.today;
      // Enabling starts at the ceiling. Policy edits clamp a same-day sample;
      // they never draw another value for a day that already has one.
      effective = row.actuator_daily_reply_cap_min === null || row.sampled_day === null
        ? policy.cap : row.sampled_day === row.today
          ? Math.min(policy.cap, Math.max(minimum, row.actuator_daily_reply_cap_effective ?? policy.cap))
          : draw(minimum, policy.cap, row.actuator_daily_reply_cap_effective);
    }
    await tx`update noelle.agent_instances set actuator_daily_reply_cap=${policy.cap},
      actuator_daily_reply_cap_min=${minimum}, actuator_daily_reply_cap_day=${day}::date,
      actuator_daily_reply_cap_effective=${effective}, updated_at=now()
      where id=${identity.instanceId} and org_id=${identity.orgId} and role='x_intern'`;
    return minimum === null || policy.cap === null
      ? { cap: resolveBrowserReplyCap("x", policy.cap) }
      : { cap: effective!, configuredCap: policy.cap, minimum, day: day! };
  });
}

import type { Sql } from "postgres";
import { passesUnattendedReplyReview } from "@noelle/contracts";
import { autoSendRemainingBudget, computeAutoSendSchedule } from "./autosend-schedule.js";

type Selected = { id: string; agent_instance_id: string; lead_id: string; payload: Record<string, unknown> };
type Scheduled = { approval_id: string; target_at: string };
export type ScheduleApprovalsResult = { error: "sending_disabled" } | { scheduled: Scheduled[]; count: number; withheld: number };

/** Lock owning instances before reading budgets and stamping selected reply angles. */
export async function scheduleAutoSendApprovals(sql: Sql, args: {
  orgId: string; approvalIds: string[]; userId: string; cap: number;
  requireSendEnabled: boolean; quietStartHourUtc: number; quietEndHourUtc: number;
}): Promise<ScheduleApprovalsResult> {
  const ids = [...new Set(args.approvalIds)].slice(0, 200);
  if (ids.length === 0) return { scheduled: [], count: 0, withheld: 0 };
  return sql.begin(async (tx) => {
    await tx`select set_config('lock_timeout','5s',true),set_config('statement_timeout','10s',true)`;
    // Lock in deterministic order. Separate subsequent reads see committed stamps
    // from a concurrent scheduler that held these locks first.
    const instances = await tx<{ id: string; reply_send_enabled: boolean; min: number; max: number; now: Date }[]>`
      select instance.id, instance.reply_send_enabled, instance.auto_send_min_delay_sec as min,
        instance.auto_send_max_delay_sec as max, now() as now
      from noelle.agent_instances instance
      where instance.org_id=${args.orgId} and instance.role='x_intern'
        and exists (select 1 from noelle.approvals a where a.org_id=${args.orgId}
          and a.agent_instance_id=instance.id and a.id=any(${ids}::uuid[]) and a.status='pending')
      order by instance.id for update of instance`;
    const rows = await tx<Selected[]>`
      select a.id,a.agent_instance_id,a.lead_id,d.payload
      from noelle.approvals a
      join noelle.drafts d on d.id=a.draft_id and d.org_id=a.org_id
      join noelle.leads l on l.id=a.lead_id and l.org_id=a.org_id and l.agent_instance_id=a.agent_instance_id
      where a.org_id=${args.orgId} and a.id=any(${ids}::uuid[]) and a.status='pending'
        and a.auto_send_target_at is null and l.platform='x'
        and a.agent_instance_id=any(${instances.map((row) => row.id)}::uuid[])
        and coalesce(d.payload->>'kind','reply') <> 'dm'
        and d.sent_at is null and d.sent_external_id is null
      order by array_position(${ids}::uuid[],a.id) for update of a`;
    if (args.requireSendEnabled && instances.some((instance) => !instance.reply_send_enabled)) return { error: "sending_disabled" };
    const plans: (Scheduled & { lead_id: string })[] = [];
    const chosenLeads = new Set<string>();
    for (const instance of instances) {
      // Count transfers between pending and sent in one snapshot, including all
      // existing future stamps. Appending also preserves gaps between batches.
      const [usage] = await tx<{ sent: number; pending: number; last: Date | null }[]>`
        select count(*) filter (where status='sent' and decided_by='auto-send' and decided_at>=now()-interval '24 hours')::int as sent,
          count(*) filter (where status='pending' and auto_send_target_at is not null)::int as pending,
          max(auto_send_target_at) filter (where status='pending') as last
        from noelle.approvals where org_id=${args.orgId} and agent_instance_id=${instance.id}
          and ((status='pending' and auto_send_target_at is not null)
            or (status='sent' and decided_by='auto-send' and decided_at>=now()-interval '24 hours'))`;
      const remaining = autoSendRemainingBudget({ cap: args.cap, sentLast24h: usage?.sent ?? 0, pendingScheduled: usage?.pending ?? 0 });
      const selected = rows.filter((row) => {
        if (row.agent_instance_id !== instance.id || chosenLeads.has(row.lead_id)) return false;
        if (!passesUnattendedReplyReview(row.payload.verifier_meta)) return false;
        const body = row.payload.edited_body ?? row.payload.body;
        if (typeof body !== "string" || !body.trim()) return false;
        if (row.payload.human_review_required === true && row.payload.human_send_approved !== true) return false;
        chosenLeads.add(row.lead_id);
        return true;
      }).slice(0, remaining);
      const targets = computeAutoSendSchedule({ count: selected.length,
        startAtMs: Math.max(instance.now.getTime(), usage?.last?.getTime() ?? 0), minGapSec: instance.min, maxGapSec: instance.max,
        quietStartHourUtc: validHour(args.quietStartHourUtc, 4), quietEndHourUtc: validHour(args.quietEndHourUtc, 12) });
      selected.forEach((row, index) => plans.push({ approval_id: row.id, lead_id: row.lead_id, target_at: new Date(targets[index]!).toISOString() }));
    }
    if (plans.length === 0) return { scheduled: [], count: 0, withheld: rows.length };
    const stamped = await tx<{ id: string; lead_id: string }[]>`
      update noelle.approvals a set auto_send_target_at=plan.target_at,updated_at=now()
      from jsonb_to_recordset(${tx.json(plans)}::jsonb) as plan(approval_id uuid,target_at timestamptz,lead_id uuid)
      where a.id=plan.approval_id and a.org_id=${args.orgId} and a.status='pending' and a.auto_send_target_at is null
      returning a.id,a.lead_id`;
    const stampedIds = new Set(stamped.map((row) => row.id));
    if (stamped.length > 0) await tx`
      update noelle.approvals a set status='skipped',decided_at=now(),decided_by=${args.userId},skip_reason='sibling-angle-autosend'
      from noelle.drafts d where d.id=a.draft_id and d.org_id=a.org_id and a.org_id=${args.orgId}
        and a.lead_id=any(${stamped.map((row) => row.lead_id)}::uuid[]) and not (a.id=any(${stamped.map((row) => row.id)}::uuid[]))
        and a.status='pending' and coalesce(d.payload->>'kind','reply') <> 'dm'`;
    const scheduled = plans.filter((row) => stampedIds.has(row.approval_id)).map(({ approval_id, target_at }) => ({ approval_id, target_at }));
    return { scheduled, count: scheduled.length, withheld: rows.length - scheduled.length };
  });
}

function validHour(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 23 ? value : fallback;
}

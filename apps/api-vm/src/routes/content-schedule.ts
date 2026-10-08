import { Hono } from "hono";
import {
  CreateSlotInSchema,
  RescheduleSlotInSchema,
  ComposeBulkInSchema,
  COMPOSE_MAX_ITEMS,
  type CreateSlotIn,
  type RescheduleSlotIn,
  type ComposeBulkIn,
} from "@noelle/contracts";
import { computeComposeSlots } from "../lib/content-slots.js";
import { ContentScheduleWriteError, createManualContentSlot, mutateContentSlot, withContentScheduleOwner } from "../lib/content-schedule-db.js";
import { noelleDb } from "../lib/db.js";
import { isOrgMember } from "../lib/auth.js";
import type { AuthContext } from "../middleware/jwt.js";

/**
 * Content Schedule calendar writes. Reads are done directly in the app
 * (schedule-queries.ts). Tenancy: every handler resolves the owning org and
 * checks `isOrgMember` before touching a slot — there is no RLS. The DB trigger
 * `content_schedule_slots_autopublish_role_chk` is the structural backstop that
 * keeps auto_publish=true off draft-only agents even if app code slips.
 */
export const contentSchedule = new Hono<{ Variables: { auth: AuthContext } }>();

/** Postgres raises this when a non-x_intern owner is given an auto_publish slot. */
function isAutoPublishRoleViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("auto_publish is only permitted");
}

function scheduleWriteFailure(err: unknown): { error: string; status: 400 | 403 | 404 | 409 } | null {
  if (!(err instanceof ContentScheduleWriteError)) return null;
  const status = err.category === "invalid_draft" ? 400
    : err.category === "auto_publish_forbidden" ? 403
    : err.category === "instance_not_found" || err.category === "slot_not_found" ? 404 : 409;
  return { error: err.category, status };
}

// Place a slot on the calendar (manual scheduling).
contentSchedule.post("/api/content/slots", async (c) => {
  const auth = c.get("auth");
  let payload: CreateSlotIn;
  try {
    payload = CreateSlotInSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }

  const sql = noelleDb();
  const [instance] = await sql<{ org_id: string; role: string }[]>`
    select org_id, role from noelle.agent_instances where id = ${payload.instanceId}
  `;
  if (!instance) return c.json({ error: "instance_not_found" }, 404);
  if (!(await isOrgMember(auth.userId, instance.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  try {
    const slot = await createManualContentSlot(sql, instance.org_id, payload);
    return c.json(slot, 201);
  } catch (err) {
    const failure = scheduleWriteFailure(err);
    if (failure) return c.json({ error: failure.error }, failure.status);
    if (isAutoPublishRoleViolation(err)) {
      return c.json({ error: "auto_publish_forbidden", detail: "only Vega (x_intern) may auto-publish" }, 403);
    }
    throw err;
  }
});

// Drag-reschedule a slot.
contentSchedule.patch("/api/content/slots/:id", async (c) => {
  const auth = c.get("auth");
  const slotId = c.req.param("id");
  let payload: RescheduleSlotIn;
  try {
    payload = RescheduleSlotInSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }

  const sql = noelleDb();
  const [slot] = await sql<{ org_id: string; status: string }[]>`
    select org_id, status from noelle.content_schedule_slots where id = ${slotId}
  `;
  if (!slot) return c.json({ error: "slot_not_found" }, 404);
  if (!(await isOrgMember(auth.userId, slot.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }
  if (slot.status === "published" || slot.status === "publishing") {
    return c.json({ error: "slot_locked", detail: "a published/publishing slot can't be moved" }, 409);
  }

  try {
    return c.json(await mutateContentSlot(sql, { id: slotId, orgId: slot.org_id, slotAt: payload.slotAt }));
  } catch (err) {
    const failure = scheduleWriteFailure(err);
    if (failure) return c.json({ error: failure.error }, failure.status);
    throw err;
  }
});

// Soft-delete (skip) a slot.
contentSchedule.delete("/api/content/slots/:id", async (c) => {
  const auth = c.get("auth");
  const slotId = c.req.param("id");
  const sql = noelleDb();
  const [slot] = await sql<{ org_id: string; status: string }[]>`
    select org_id, status from noelle.content_schedule_slots where id = ${slotId}
  `;
  if (!slot) return c.json({ error: "slot_not_found" }, 404);
  if (!(await isOrgMember(auth.userId, slot.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }
  if (slot.status === "published" || slot.status === "publishing") {
    return c.json({ error: "slot_locked" }, 409);
  }
  try {
    const updated = await mutateContentSlot(sql, { id: slotId, orgId: slot.org_id });
    return c.json({ id: updated.id, status: updated.status });
  } catch (err) {
    const failure = scheduleWriteFailure(err);
    if (failure) return c.json({ error: failure.error }, failure.status);
    throw err;
  }
});

// Default posting windows (UTC) per platform for the auto-picker / bulk fill.
const DEFAULT_WINDOWS: Record<string, number[]> = {
  x: [14, 17, 21],
  linkedin: [13, 16],
  reddit: [15, 23],
  video: [16, 22],
};

// Compose bulk action: "N posts/day for M days" → one agent_compose_jobs header,
// N approved post_ideas, and N empty schedule slots, all in ONE transaction.
// ZERO LLM here — the existing drafter fills the ideas (chunked, OOM-safe); the
// draft→slot bind (post-drafts route) flips each slot to 'ready'.
contentSchedule.post("/api/content/slots/bulk", async (c) => {
  const auth = c.get("auth");
  let payload: ComposeBulkIn;
  try {
    payload = ComposeBulkInSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_body", detail: err instanceof Error ? err.message : String(err) }, 400);
  }

  // Reject a runaway plan BEFORE expanding the array (OOM guard).
  const total = payload.perDay * payload.days;
  if (total > COMPOSE_MAX_ITEMS) {
    return c.json({ error: "too_many_items", detail: `${total} items exceeds the ${COMPOSE_MAX_ITEMS} cap` }, 400);
  }

  const sql = noelleDb();
  const [inst] = await sql<Array<{ org_id: string; role: string }>>`
    select org_id, role from noelle.agent_instances where id = ${payload.instanceId}
  `;
  if (!inst) return c.json({ error: "instance_not_found" }, 404);
  if (!(await isOrgMember(auth.userId, inst.org_id))) return c.json({ error: "not_org_member" }, 403);
  if (payload.autoPublish && inst.role !== "x_intern") {
    return c.json({ error: "auto_publish_forbidden", detail: "only Vega (x_intern) may auto-publish" }, 403);
  }

  const windows = DEFAULT_WINDOWS[payload.platform] ?? [13, 16, 19, 21];
  const slotTimes = computeComposeSlots({
    startDate: payload.startDate,
    days: payload.days,
    perDay: payload.perDay,
    windowsUtc: windows,
  });
  const hook = (payload.topic ?? "On-brand post").slice(0, 280);
  const JIT_MS = 36 * 60 * 60 * 1000;

  let jobId: string;
  try {
    jobId = await withContentScheduleOwner(sql, { orgId: inst.org_id, instanceId: payload.instanceId,
      platform: payload.platform, autoPublish: payload.autoPublish }, async (tx) => {
    const [job] = await tx<Array<{ id: string }>>`
      insert into noelle.agent_compose_jobs
        (org_id, agent_instance_id, kind, prompt, plan, status, items_total, horizon_days, created_by)
      values
        (${inst.org_id}, ${payload.instanceId}, 'bulk_draft', ${payload.topic ?? null},
         ${tx.json({ perDay: payload.perDay, days: payload.days, windows })}, 'running',
         ${slotTimes.length}, ${payload.days}, ${auth.userId})
      returning id
    `;
    for (const slotAt of slotTimes) {
      const [idea] = await tx<Array<{ id: string }>>`
        insert into noelle.post_ideas
          (org_id, agent_instance_id, platform, hook, status, batch_id, target_platforms)
        values
          (${inst.org_id}, ${payload.instanceId}, ${payload.platform}, ${hook}, 'approved',
           ${job!.id}, ${[payload.platform]})
        returning id
      `;
      const materializeAfter = new Date(new Date(slotAt).getTime() - JIT_MS).toISOString();
      await tx`
        insert into noelle.content_schedule_slots

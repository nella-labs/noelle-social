import { Hono } from "hono";
import { BusEmitInSchema, BusPutInSchema, BusEventsQuerySchema, BusStateQuerySchema } from "@noelle/contracts";
import { isOrgMember } from "../lib/auth.js";
import { noelleDb } from "../lib/db.js";
import { requireHmac } from "../middleware/hmac.js";
import type { AuthContext } from "../middleware/jwt.js";

// Shared memory bus HTTP surface.
//   - GET  /api/bus/events  (JWT)  — dashboard/orchestration view reads the
//     org's recent activity stream.
//   - GET  /api/bus/state   (JWT)  — reads current-value KV "buckets".
//   - POST /api/bus/emit    (HMAC) — out-of-process emitters append an event.
//   - POST /api/bus/state   (HMAC) — out-of-process emitters upsert KV state.
//
// In-process workers write DIRECTLY via createBus (packages/runtime/src/bus.ts);
// these HMAC routes exist for emitters that aren't holding a Cloud SQL handle.
// See docs/shared-memory-bus.md.

const isoOrNull = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

// ── Read (JWT) ───────────────────────────────────────────────────────────────

const busRead = new Hono<{ Variables: { auth: AuthContext } }>();

busRead.get("/api/bus/events", async (c) => {
  const auth = c.get("auth");
  const orgId = c.req.query("org_id");
  if (!orgId) return c.json({ error: "missing_org_id" }, 400);
  const query = BusEventsQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ error: "invalid_query" }, 400);
  if (!(await isOrgMember(auth.userId, orgId))) {
    return c.json({ error: "not_org_member" }, 403);
  }
  const { topic, agent_instance_id: instanceId, limit } = query.data;

  const sql = noelleDb();
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      select id, org_id, agent_instance_id, agent_role, worker, topic,
             severity, summary, payload, correlation_id, created_at
      from noelle.bus_events
      where org_id = ${orgId}
        ${topic ? sql`and topic = ${topic}` : sql``}
        ${instanceId ? sql`and agent_instance_id = ${instanceId}` : sql``}
      order by created_at desc
      limit ${limit}
    `;
    return c.json({
      events: rows.map((r) => ({
        id: String(r.id),
        org_id: String(r.org_id),
        agent_instance_id: (r.agent_instance_id as string | null) ?? null,
        agent_role: String(r.agent_role),
        worker: (r.worker as string | null) ?? null,
        topic: String(r.topic),
        severity: String(r.severity),
        summary: (r.summary as string | null) ?? null,
        payload: r.payload ?? {},
        correlation_id: (r.correlation_id as string | null) ?? null,
        created_at: isoOrNull(r.created_at),
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "bus_read_failed", detail: msg }, 502);
  }
});

busRead.get("/api/bus/state", async (c) => {
  const auth = c.get("auth");
  const orgId = c.req.query("org_id");
  if (!orgId) return c.json({ error: "missing_org_id" }, 400);
  const query = BusStateQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ error: "invalid_query" }, 400);
  if (!(await isOrgMember(auth.userId, orgId))) {
    return c.json({ error: "not_org_member" }, 403);
  }
  const { bucket } = query.data;

  const sql = noelleDb();
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      select org_id, bucket, key, value, version,
             updated_by_instance_id, updated_by_worker, expires_at, updated_at
      from noelle.bus_state
      where org_id = ${orgId}
        and (expires_at is null or expires_at > now())
        ${bucket ? sql`and bucket = ${bucket}` : sql``}
      order by bucket, key
    `;
    return c.json({
      entries: rows.map((r) => ({
        org_id: String(r.org_id),
        bucket: String(r.bucket),
        key: String(r.key),
        value: r.value ?? null,
        version: Number(r.version), // bigint → string from postgres.js
        updated_by_instance_id: (r.updated_by_instance_id as string | null) ?? null,
        updated_by_worker: (r.updated_by_worker as string | null) ?? null,
        expires_at: isoOrNull(r.expires_at),
        updated_at: isoOrNull(r.updated_at),
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "bus_read_failed", detail: msg }, 502);
  }
});

// ── Write (HMAC) ─────────────────────────────────────────────────────────────

// HMAC is applied as PER-ROUTE middleware (not a path-glob `use`) so it binds
// only to these POST methods. A path-glob would also match the JWT GET
// /api/bus/state (same path) since `use` is method-agnostic and the vm sub-app
// mounts before the user sub-app — the classic Hono route-shadow trap.
const busWrite = new Hono();

busWrite.post("/api/bus/emit", requireHmac, async (c) => {
  let payload;
  try {
    payload = BusEmitInSchema.parse(await c.req.json());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "invalid_body", detail: msg }, 400);
  }
  const sql = noelleDb();
  try {
    await sql`
      insert into noelle.bus_events
        (org_id, agent_instance_id, agent_role, worker, topic, severity, summary, payload, correlation_id)
      values (${payload.org_id}, ${payload.agent_instance_id ?? null}, ${payload.agent_role},
              ${payload.worker ?? null}, ${payload.topic}, ${payload.severity},
              ${payload.summary ?? null}, ${sql.json(payload.payload as never)}, ${payload.correlation_id ?? null})
    `;
    return c.json({ ok: true }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "bus_write_failed", detail: msg }, 502);
  }
});

busWrite.post("/api/bus/state", requireHmac, async (c) => {
  let payload;
  try {
    payload = BusPutInSchema.parse(await c.req.json());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "invalid_body", detail: msg }, 400);
  }
  const sql = noelleDb();
  try {
    await sql`
      insert into noelle.bus_state
        (org_id, bucket, key, value, updated_by_instance_id, updated_by_worker, expires_at)
      values (${payload.org_id}, ${payload.bucket}, ${payload.key},
              ${sql.json((payload.value ?? null) as never)},
              ${payload.updated_by_instance_id ?? null}, ${payload.updated_by_worker ?? null},
              ${payload.ttl_seconds ? sql`now() + (${payload.ttl_seconds} * interval '1 second')` : null})
      on conflict (org_id, bucket, key) do update set
        value                  = excluded.value,
        version                = noelle.bus_state.version + 1,
        updated_by_instance_id = excluded.updated_by_instance_id,
        updated_by_worker      = excluded.updated_by_worker,
        expires_at             = excluded.expires_at,
        updated_at             = now()
    `;
    return c.json({ ok: true }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "bus_write_failed", detail: msg }, 502);
  }
});

export { busRead, busWrite };

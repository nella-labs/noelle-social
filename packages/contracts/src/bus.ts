import { z } from "zod";
import { UuidSchema, TimestampSchema } from "./common.js";

/**
 * Shared memory bus contract.
 *
 * The bus is a Postgres-backed store any agent/worker writes to and reads from
 * at any moment (noelle.bus_events + noelle.bus_state, migration 0032). Two
 * shapes:
 *   - events: an append-only activity STREAM ("agent X did/observed Y").
 *   - state:  current-value KV "buckets" ("the latest state of namespace B").
 *
 * Read surface (JWT, dashboard):  GET /api/bus/events, GET /api/bus/state.
 * Write surface (HMAC, emitters): POST /api/bus/emit, POST /api/bus/state.
 * Workers write DIRECTLY via createBus (packages/runtime/src/bus.ts); the HMAC
 * routes are for out-of-process emitters. See docs/shared-memory-bus.md.
 *
 * "bucket" here is a KV NAMESPACE, unrelated to the budget spend bucket
 * (common.ts BucketSchema, llm_calls.bucket).
 */

export const BusSeveritySchema = z.enum(["info", "warn", "error"]);
export type BusSeverity = z.infer<typeof BusSeveritySchema>;

/** One row of the bus_events stream as returned to a reader. agent_role is a
 * free string because org-level events use "system" (outside AgentRoleSchema). */
export const BusEventSchema = z.object({
  id: UuidSchema,
  org_id: UuidSchema,
  agent_instance_id: UuidSchema.nullable(),
  agent_role: z.string(),
  worker: z.string().nullable(),
  topic: z.string(),
  severity: BusSeveritySchema,
  summary: z.string().nullable(),
  payload: z.record(z.unknown()),
  correlation_id: z.string().nullable(),
  created_at: TimestampSchema,
});
export type BusEvent = z.infer<typeof BusEventSchema>;

/** One current-value KV entry from bus_state. version is a NUMBER here: the DB
 * column is bigint (postgres.js returns it as a string), coerced on read. */
export const BusStateEntrySchema = z.object({
  org_id: UuidSchema,
  bucket: z.string(),
  key: z.string(),
  value: z.unknown(),
  version: z.number(),
  updated_by_instance_id: UuidSchema.nullable(),
  updated_by_worker: z.string().nullable(),
  expires_at: TimestampSchema.nullable(),
  updated_at: TimestampSchema,
});
export type BusStateEntry = z.infer<typeof BusStateEntrySchema>;

// ── Read queries (JWT) ───────────────────────────────────────────────────────

export const BusEventsQuerySchema = z.object({
  org_id: UuidSchema,
  topic: z.string().optional(),
  agent_instance_id: UuidSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});
export type BusEventsQuery = z.infer<typeof BusEventsQuerySchema>;

export const BusStateQuerySchema = z.object({
  org_id: UuidSchema,
  bucket: z.string().optional(),
});
export type BusStateQuery = z.infer<typeof BusStateQuerySchema>;

export const BusEventsResponseSchema = z.object({
  events: z.array(BusEventSchema),
});
export type BusEventsResponse = z.infer<typeof BusEventsResponseSchema>;

export const BusStateResponseSchema = z.object({
  entries: z.array(BusStateEntrySchema),
});
export type BusStateResponse = z.infer<typeof BusStateResponseSchema>;

// ── Write bodies (HMAC, out-of-process emitters) ─────────────────────────────

export const BusEmitInSchema = z.object({
  org_id: UuidSchema,
  agent_instance_id: UuidSchema.nullish(),
  agent_role: z.string(),
  worker: z.string().nullish(),
  topic: z.string().min(1),
  severity: BusSeveritySchema.default("info"),
  summary: z.string().nullish(),
  payload: z.record(z.unknown()).default({}),
  correlation_id: z.string().nullish(),
});
export type BusEmitIn = z.infer<typeof BusEmitInSchema>;

export const BusPutInSchema = z.object({
  org_id: UuidSchema,
  bucket: z.string().min(1),
  key: z.string().min(1),
  value: z.unknown(),
  updated_by_instance_id: UuidSchema.nullish(),
  updated_by_worker: z.string().nullish(),
  ttl_seconds: z.number().int().positive().nullish(),
});
export type BusPutIn = z.infer<typeof BusPutInSchema>;

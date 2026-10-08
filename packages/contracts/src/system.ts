import { z } from "zod";
import { TimestampSchema } from "./common.js";

/**
 * Self-host VM observability contract.
 *
 * GET /api/system/status  — the single payload the in-browser "System" page
 *   (apps/app) renders so a self-host operator can watch the VM: service
 *   health, per-worker freshness, applied schema, and which LLM providers are
 *   configured. The same schema backs the CLI `noelle status --json`, so the
 *   terminal and the dashboard read from one source of truth.
 *
 * This is a self-host surface; on the managed (Vercel + GCP VM) deployment the
 * route is unused. Keeping it in @noelle/contracts (next to health.ts) means
 * the API and UI move together — there is no second, drifting status schema.
 */

/** Reuses the health.ts vocabulary: reachable+healthy / slow / failing / off. */
export const ServiceStateSchema = z.enum(["ok", "degraded", "down", "disabled"]);
export type ServiceState = z.infer<typeof ServiceStateSchema>;

export const ServiceStatusSchema = z.object({
  /** "postgres" | "api-vm" | "app" | "discovery" | "classifier" | … */
  name: z.string(),
  state: ServiceStateSchema,
  /** Probe round-trip in ms, when measured. */
  latencyMs: z.number().nonnegative().optional(),
  /** Human-readable detail when state != "ok". */
  detail: z.string().optional(),
});
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

/** Per-worker liveness derived from noelle.worker_runs. */
export const WorkerRunStatusSchema = z.object({
  kind: z.enum(["discovery", "classifier", "drafter", "send"]),
  /** Null when the worker has never recorded a successful run. */
  lastSuccessAt: TimestampSchema.nullable(),
  /** True when lastSuccessAt is older than the worker's stale threshold. */
  stale: z.boolean(),
  /** Whether the worker process is enabled in this deployment. */
  enabled: z.boolean(),
});
export type WorkerRunStatus = z.infer<typeof WorkerRunStatusSchema>;

/** Which LLM provider credentials the box has configured. */
export const ProviderConfigSchema = z.object({
  anthropic: z.boolean(),
  openai: z.boolean(),
  codex: z.boolean(),
  vertex: z.boolean(),
  bedrock: z.boolean(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const SchemaStatusSchema = z.object({
  /** Migration filenames that have been applied (best-effort sentinel check). */
  applied: z.array(z.string()),
  /** Migration filenames known to the repo but not yet applied. */
  pending: z.array(z.string()),
});
export type SchemaStatus = z.infer<typeof SchemaStatusSchema>;

export const HostInfoSchema = z.object({
  platform: z.enum(["darwin", "linux", "win32", "unknown"]),
  uptimeSeconds: z.number().nonnegative(),
  /** api-vm build version (git SHA or semver). */
  version: z.string(),
  /** Public hostname when a Cloudflare tunnel is active; null otherwise. */
  tunnel: z.string().nullable(),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;

export const SystemStatusSchema = z.object({
  ok: z.boolean(),
  service: z.literal("noelle-self-host"),
  ts: TimestampSchema,
  host: HostInfoSchema,
  services: z.array(ServiceStatusSchema),
  schema: SchemaStatusSchema,
  providers: ProviderConfigSchema,
  workerRuns: z.array(WorkerRunStatusSchema),
});
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

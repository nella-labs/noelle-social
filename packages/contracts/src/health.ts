import { z } from "zod";
import { TimestampSchema } from "./common.js";

/**
 * Health + readiness contracts. See docs/scalability.md § 5.
 *
 * GET /healthz  — liveness. Cheap, never touches dependencies. Used by load
 *                 balancers and systemd `WatchdogSec=`.
 * GET /readyz   — readiness. Probes each declared dependency and reports the
 *                 first failure. Used by deploy gates and the dashboard
 *                 "service status" widget.
 */

export const HealthStatusSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
  /** Git SHA or semver of the running build. */
  version: z.string(),
  /** Process uptime in seconds. */
  uptimeSeconds: z.number().nonnegative(),
  ts: TimestampSchema,
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const DependencyStatusSchema = z.object({
  name: z.string(),
  /** "ok" if reachable + healthy; "degraded" if slow; "down" if failing. */
  status: z.enum(["ok", "degraded", "down"]),
  /** Round-trip latency observed during this probe, in ms. */
  latencyMs: z.number().nonnegative().optional(),
  /** Human-readable detail when status != "ok". */
  detail: z.string().optional(),
});
export type DependencyStatus = z.infer<typeof DependencyStatusSchema>;

export const ReadinessStatusSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  version: z.string(),
  ts: TimestampSchema,
  dependencies: z.array(DependencyStatusSchema),
});
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;

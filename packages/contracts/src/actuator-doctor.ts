import { z } from "zod";

// Contracts for the actuator-doctor — the self-healing watchdog that keeps
// Vega/X, Lyra/LinkedIn, and Orion/Reddit actuating without human babysitting.
//
// The doctor runs as a pm2 loop. Each tick it: probes (deterministic) ->
// diagnoses to a stable failure signature -> remediates via a capped ladder ->
// verifies on the next tick -> records the outcome. Unknown or stubborn
// failures escalate to a flag-gated headless `claude -p` fixer that writes a NEW
// signature (never auto-merges code). Signatures are the self-improvement store:
// each confirmed fix teaches the doctor to fix the same failure mechanically
// next time.
//
// These shapes are the on-disk contract for signatures.json, incidents.ndjson,
// and the doctor's status report (read by the CLI + MCP). Runtime state lives in
// ~/.noelle/doctor/ (seeded from apps/actuator-doctor/signatures.seed.json).

// The lanes the doctor watches. "bridge" = the Chrome Bridge control server.
export const DoctorTargetSchema = z.enum([
  "x-actuator",
  "linkedin-actuator",
  "reddit-intern",
  "bridge",
  "api-vm",
]);
export type DoctorTarget = z.infer<typeof DoctorTargetSchema>;

/** Installed manifest names used to resolve each browser actuator without guessing an ID. */
export const ACTUATOR_EXTENSION_NAMES = {
  "x-actuator": "Noelle X Actuator",
  "linkedin-actuator": "Noelle LinkedIn Actuator",
  "reddit-intern": "Noelle Reddit Actuator",
} as const satisfies Partial<Record<DoctorTarget, string>>;

// A single probe outcome for one target on one tick.
export const ProbeResultSchema = z.object({
  target: DoctorTargetSchema,
  check: z.string(), // "pm2", "lane_freshness", "heartbeat", "stuck_queue", "build_stamp", "chrome_reachable", "send_failures"
  ok: z.boolean(),
  // when ok=false, a short machine-stable reason used for signature matching.
  reason: z.string().optional(),
  // metrics the check produced (age_ms, queue_depth, stale_minutes, ...).
  metrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).default({}),
  at: z.string(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

// The remediation ladder. Ordered from least to most disruptive. Each step is
// capped per hour in config; the doctor climbs only as far as the signature
// prescribes, and every step alerts.
export const RemediationActionSchema = z.enum([
  "none", // observe only (used while a lane is intentionally paused)
  "reload_extension", // ask the bridge to reload the selected local extension
  "reconnect_bridge", // restart the chrome-bridge pm2 app (ext will reconnect)
  "restart_worker", // pm2 restart <app> --update-env
  "engage_kill_switch", // set reply_send_enabled=false (fail-closed) + page
  "page_human", // notify.sh only; nothing automatic left to try
]);
export type RemediationAction = z.infer<typeof RemediationActionSchema>;

// A failure signature: the learned unit. Matched mechanically against the
// tick's probe results. This is what accumulates as the doctor learns.
export const SignatureSchema = z.object({
  id: z.string().min(1), // kebab slug, e.g. "ext-heartbeat-stale-while-armed"
  title: z.string(),
  description: z.string(),
  // Match rule: ALL clauses must hold for the signature to fire. A clause reads
  // a probe by (target, check) and asserts on ok/reason/metric.
  match: z
    .array(
      z.object({
        target: DoctorTargetSchema,
        check: z.string(),
        ok: z.boolean().optional(), // require probe.ok === this
        reasonIncludes: z.string().optional(), // substring match on probe.reason
        metric: z.string().optional(), // metric key to compare
        op: z.enum(["gt", "gte", "lt", "lte", "eq", "ne"]).optional(),
        value: z.union([z.number(), z.string(), z.boolean()]).optional(),
      }),
    )
    .min(1),
  // The remediation ladder for this signature, tried in order until a step
  // clears the fault on a later tick.
  ladder: z.array(RemediationActionSchema).min(1),
  // Guardrail: never auto-remediate more than this many times per hour for this
  // signature; beyond it, escalate straight to page_human.
  maxPerHour: z.number().int().min(1).default(3),
  // Bookkeeping the doctor maintains as it learns.
  timesSeen: z.number().int().default(0),
  timesResolved: z.number().int().default(0),
  lastSeen: z.string().nullable().default(null),
  // "seed" = shipped in the repo; "learned" = written by the escalation fixer.
  origin: z.enum(["seed", "learned"]).default("seed"),
  confidence: z.number().min(0).max(1).default(0.5),
  // Optional pointer to the incident + branch that taught this signature.
  learnedFrom: z.string().optional(),
});
export type Signature = z.infer<typeof SignatureSchema>;

export const SignatureStoreSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  signatures: z.array(SignatureSchema),
});
export type SignatureStore = z.infer<typeof SignatureStoreSchema>;

// One incident = one detected fault and everything the doctor did about it.
// Appended to ~/.noelle/doctor/incidents.ndjson (an audit trail + the input the
// escalation fixer reads).
export const IncidentSchema = z.object({
  id: z.string(), // time-sortable id
  at: z.string(),
  target: DoctorTargetSchema,
  signatureId: z.string().nullable(), // null = unmatched (candidate for escalation)
  summary: z.string(),
  probes: z.array(ProbeResultSchema),
  actionTaken: RemediationActionSchema,
  actionOk: z.boolean().nullable(), // null until verified on a later tick
  verifiedAt: z.string().nullable().default(null),
  resolved: z.boolean().default(false),
  escalated: z.boolean().default(false),
  notes: z.string().optional(),
});
export type Incident = z.infer<typeof IncidentSchema>;

// The doctor's status report — what `noelle doctor status` and the MCP tool
// return. A snapshot of the latest tick.
export const DoctorReportSchema = z.object({
  at: z.string(),
  tick: z.number(),
  healthy: z.boolean(),
  targets: z.array(
    z.object({
      target: DoctorTargetSchema,
      healthy: z.boolean(),
      armed: z.boolean(), // reply_send_enabled / lane switched on
      inWindow: z.boolean(), // inside the lane's active hours (heartbeat expected)
      probes: z.array(ProbeResultSchema),
      openIncident: IncidentSchema.nullable(),
    }),
  ),
  remediationsThisHour: z.record(z.string(), z.number()),
  autofixEnabled: z.boolean(), // NOELLE_DOCTOR_AUTOFIX
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

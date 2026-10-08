import { z } from "zod";

// Recurring scheduled run (0085_run_schedule.sql). A per-intern-instance standing
// schedule that auto-fires the existing Start-all run on a timer. The api-vm
// scheduler (apps/api-vm/src/lib/scheduler.ts) reads this off
// noelle.agent_instances.run_schedule and, when run_schedule_next_at is due,
// stamps the same goal-run columns startAll writes. A firing is nothing more than
// "press Start all with goal = N"; the worker auto-pause (enforceGoal) still stops
// the run at the target.
//
// Two cadence modes only (interval + daily) — deliberately not a raw cron field:
//   - interval → every `intervalHours` hours from the last firing.
//   - daily    → once a day at `dailyTime` (HH:MM) in `timezone`.
export const RunScheduleSchema = z
  .object({
    /** Master arm switch. false ⇒ the scheduler ignores the row and clears next_at. */
    enabled: z.boolean(),
    mode: z.enum(["interval", "daily"]),
    /** interval mode: fire every N hours (1..168). Required when mode="interval". */
    intervalHours: z.number().int().min(1).max(168).nullable().optional(),
    /**
     * daily mode: 24h wall-clock time "HH:MM" in `timezone` to fire at.
     * Required when mode="daily".
     */
    dailyTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM 24-hour time")
      .nullable()
      .optional(),
    /** IANA timezone the daily time is interpreted in, e.g. "America/Bogota". */
    timezone: z.string().min(1).max(64),
    /** goal_target each firing opens the run with (1..500), same bounds as Start all. */
    goal: z.number().int().positive().max(500),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === "interval" && v.intervalHours == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intervalHours"],
        message: "intervalHours is required for interval mode",
      });
    }
    if (v.mode === "daily" && (v.dailyTime == null || v.dailyTime === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dailyTime"],
        message: "dailyTime is required for daily mode",
      });
    }
  });

export type RunSchedule = z.infer<typeof RunScheduleSchema>;

/**
 * Validate a raw run_schedule jsonb blob. Returns the parsed schedule, or null
 * when the column is empty or the stored shape no longer validates (fail-safe:
 * an unparseable schedule is treated as "no schedule", never fired).
 */
export function parseRunSchedule(raw: unknown): RunSchedule | null {
  // Self-heal legacy double-encoded rows: an earlier writer used
  // `${JSON.stringify(schedule)}::jsonb`, which postgres.js re-encodes into a
  // jsonb *string* (it JSON-serializes jsonb-bound params itself). Such a column
  // reads back as a JS string, not an object. Decode one level so those rows
  // still parse; the write path now stores a proper object via sql.json(...).
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value == null || typeof value !== "object") return null;
  const res = RunScheduleSchema.safeParse(value);
  return res.success ? res.data : null;
}

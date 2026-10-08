/**
 * Vega auto-curate — the grade-gated auto-schedule decision + pacing, as pure
 * functions (no DB, no env access) so the whole gate is unit-testable offline.
 * The wiring in routes/post-drafts.ts resolves the config from env, reads the
 * instance's last active slot for pacing, and applies the decision.
 *
 * The pain this removes: in the review-first Content flow the operator approves
 * every idea AND marks every generated draft ready before it can be scheduled.
 * With auto-curate ON, freshly-ideated X ideas auto-approve (routes/post-ideas)
 * and each generated X draft is graded here: a good one is scheduled (paced),
 * a weak one is dropped — no per-post clicking.
 *
 * Safety: X/Vega-only (a non-x_intern owner, or a non-`x` draft, is never
 * touched); a draft with no score (verifier off) falls back to manual review;
 * a verifier-FAILED draft (a hard-rule violation like an em dash or a banned
 * slop phrase) is dismissed even if its mean score is high, so auto-publish
 * never ships one. Defaults live in env.ts; everything is off unless enabled.
 */

export interface AutoCurateConfig {
  /** Master switch (NOELLE_POST_AUTOSCHEDULE). */
  enabled: boolean;
  /** Pass bar on the 0..1 quality_score scale (env MIN_SCORE / 100). */
  minScore: number;
  /** Do qualifying slots auto_publish (post via X API) or stop at `ready`? */
  autoPublish: boolean;
  /** Pacing: minimum minutes between two auto-scheduled slots. */
  spacingMinutes: number;
  /** Earliest an auto-scheduled slot may fire, in minutes from now. */
  leadMinutes: number;
}

/** Shape of the env fields this consumes (a subset of the api-vm Env). */
export interface AutoCurateEnv {
  NOELLE_POST_AUTOSCHEDULE: boolean;
  NOELLE_POST_AUTOSCHEDULE_MIN_SCORE: number;
  NOELLE_POST_AUTOSCHEDULE_AUTOPUBLISH: boolean;
  NOELLE_POST_AUTOSCHEDULE_SPACING_MIN: number;
  NOELLE_POST_AUTOSCHEDULE_LEAD_MIN: number;
}

/** Normalize the env knobs into the 0..1-scale config the gate compares against. */
export function resolveAutoCurateConfig(env: AutoCurateEnv): AutoCurateConfig {
  const raw = env.NOELLE_POST_AUTOSCHEDULE_MIN_SCORE;
  // The env is 0-100; the quality_score is 0..1. Clamp then normalize so a
  // misconfigured 150 or -5 can't open/close the gate unexpectedly.
  const minScore = Math.min(1, Math.max(0, raw / 100));
  return {
    enabled: env.NOELLE_POST_AUTOSCHEDULE,
    minScore,
    autoPublish: env.NOELLE_POST_AUTOSCHEDULE_AUTOPUBLISH,
    spacingMinutes: env.NOELLE_POST_AUTOSCHEDULE_SPACING_MIN,
    leadMinutes: env.NOELLE_POST_AUTOSCHEDULE_LEAD_MIN,
  };
}

export type AutoCurateAction = "skip" | "schedule" | "dismiss";

export interface AutoCurateDecision {
  action: AutoCurateAction;
  /** Only meaningful for `schedule`: whether the slot carries auto_publish. */
  autoPublish: boolean;
  /** A short machine reason, for logging. */
  reason: string;
}

/**
 * Decide what to do with one freshly-generated draft. Pure — the caller supplies
 * the owning instance's role, the draft platform, and the verifier outputs.
 *
 *   skip     → leave it as a normal draft for manual review (today's behavior)
 *   schedule → auto-schedule it into a paced slot (autoPublish per config)
 *   dismiss  → drop it (below the bar, or verifier-failed on a hard rule)
 */
export function decideAutoCurate(args: {
  config: AutoCurateConfig;
  /** agent_instances.role of the idea's OWNER (never re-derived from platform). */
  ownerRole: string | null | undefined;
  /** The draft's platform. */
  platform: string;
  /** 0..1 mean verifier score, or null when the verifier didn't run. */
  qualityScore: number | null | undefined;
  /** The verifier's overall pass/fail, or null when it didn't run. */
  qualityPassed: boolean | null | undefined;
}): AutoCurateDecision {
  const { config } = args;
  if (!config.enabled) return { action: "skip", autoPublish: false, reason: "disabled" };

  // Auto-curate is Vega-only: only an x_intern-owned X draft can auto-publish
  // (the content_schedule_slots trigger enforces this at the DB too). Any other
  // owner/platform combo is left untouched for the normal review flow.
  if (args.ownerRole !== "x_intern" || args.platform !== "x") {
    return { action: "skip", autoPublish: false, reason: "not_vega_x" };
  }

  // No score → the post-drafter's verifier is off (NOELLE_POST_VERIFY). We can't
  // grade, so DON'T blindly schedule OR dismiss — fall back to manual review.
  if (args.qualityScore == null) {
    return { action: "skip", autoPublish: false, reason: "no_score" };
  }

  // A verifier-FAILED draft carries a hard-rule violation (em dash, banned slop
  // phrase, garbled text) — exactly what must never auto-publish — so dismiss it
  // even if the mean cleared the bar. (quality_passed is null-safe: only an
  // explicit false vetoes; the score is still the primary knob.)
  const vetoed = args.qualityPassed === false;
  if (args.qualityScore >= config.minScore && !vetoed) {
    return { action: "schedule", autoPublish: config.autoPublish, reason: "at_or_above_threshold" };
  }
  return {
    action: "dismiss",
    autoPublish: false,
    reason: vetoed ? "verifier_failed" : "below_threshold",
  };
}

/**
 * Pure pacing: the next slot time for an incrementally-arriving draft. Each new
 * qualifying draft is placed `spacingMinutes` after the last active future slot
 * (so a batch fans out over time instead of bursting), but never before
 * `now + leadMinutes`. With no prior slot the first one lands at that lead.
 */
export function nextPacedSlotAt(args: {
  now: Date;
  /** max(slot_at) among this instance's non-terminal future slots, or null. */
  lastActiveSlotAt: Date | null;
  leadMinutes: number;
  spacingMinutes: number;
}): Date {
  const earliest = new Date(args.now.getTime() + args.leadMinutes * 60_000);
  if (!args.lastActiveSlotAt) return earliest;
  const afterLast = new Date(args.lastActiveSlotAt.getTime() + args.spacingMinutes * 60_000);
  return afterLast.getTime() > earliest.getTime() ? afterLast : earliest;
}

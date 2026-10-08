import { z } from "zod";
import { UuidSchema, TimestampSchema } from "./common.js";

// Pattern Breaker wire shapes.
//
// The breaker reads the operator's last N posts, an LLM finds STRUCTURAL
// patterns that repeat too often, and the result is persisted as:
//   - pattern_rules  (machine-consumed: drafter prompt + verifier checks)
//   - pattern_alerts (operator-facing: the approvals-page popup)
//
// The LLM's raw finding is validated by PatternFindingSchema before it ever
// becomes a rule/alert — same discipline as the verifier's judge output.

export const PatternRuleKindSchema = z.enum(["phrase", "structure"]);
export type PatternRuleKind = z.infer<typeof PatternRuleKindSchema>;

export const PatternSeveritySchema = z.enum(["low", "medium", "high"]);
export type PatternSeverity = z.infer<typeof PatternSeveritySchema>;

export const PatternRuleSourceSchema = z.enum(["auto", "refined", "manual"]);
export type PatternRuleSource = z.infer<typeof PatternRuleSourceSchema>;

export const PatternAlertStatusSchema = z.enum([
  "open",
  "refining",
  "refined",
  "reverted",
  "acknowledged",
]);
export type PatternAlertStatus = z.infer<typeof PatternAlertStatusSchema>;

// One example offending post, shown in the popup so the operator can SEE the
// habit rather than take the breaker's word for it.
export const PatternExampleSchema = z.object({
  draftId: z.string().optional(),
  snippet: z.string().max(600),
});
export type PatternExample = z.infer<typeof PatternExampleSchema>;

export const PatternEvidenceSchema = z.object({
  sourceIndex: z.number().int().min(0),
  snippet: z.string().trim().min(1).max(600),
});
export type PatternEvidence = z.infer<typeof PatternEvidenceSchema>;

// The LLM judge's raw finding for ONE over-repeated pattern. Strictly validated
// before it becomes a rule + alert.
export const PatternFindingSchema = z.object({
  // Short tag, the dedup key. e.g. "wall-of-text → tiny congrats closer".
  label: z.string().min(3).max(120),
  kind: PatternRuleKindSchema,
  // Plain-English description for the operator popup ("X out of N posts open
  // with the same one-line hook then a blank line").
  description: z.string().min(8).max(600),
  // The NEVER-DO instruction injected into the drafter prompt + judge.
  instruction: z.string().min(8).max(600),
  // The positive mirror of `instruction`: one imperative "do this INSTEAD" line,
  // shown in the popup ("TRY INSTEAD") and appended to the drafter's ban block.
  // Optional — an older finding or a model that omits it degrades gracefully.
  suggestion: z.string().max(600).nullable().optional(),
  // Optional deterministic catch for kind='phrase'. The breaker validates it
  // compiles before persisting; a structure finding leaves this null.
  regex: z.string().max(300).nullable().optional(),
  severity: PatternSeveritySchema,
  // How many posts in the analyzed window exhibit the pattern.
  frequencyCount: z.number().int().min(0),
  examples: z.array(PatternExampleSchema).max(6).default([]),
  evidence: z.array(PatternEvidenceSchema).max(100).optional(),
});
export type PatternFinding = z.infer<typeof PatternFindingSchema>;

// What the LLM returns for one analysis pass.
export const PatternAnalysisSchema = z.object({
  findings: z.array(PatternFindingSchema).max(12).default([]),
});
export type PatternAnalysis = z.infer<typeof PatternAnalysisSchema>;

// ---- Approvals-page wire shapes -----------------------------------------

// A pattern_alerts row as the approvals page renders it.
export const PatternAlertViewSchema = z.object({
  id: UuidSchema,
  ruleId: UuidSchema.nullable(),
  patternName: z.string(),
  description: z.string(),
  severity: PatternSeveritySchema,
  windowSize: z.number().int(),
  frequencyCount: z.number().int(),
  examples: z.array(PatternExampleSchema),
  status: PatternAlertStatusSchema,
  // The current rule instruction (so Refine can seed its editor), null if the
  // rule was deleted.
  ruleInstruction: z.string().nullable(),
  // The positive "do this instead" line from the live rule (the popup's TRY
  // INSTEAD block). Null when the rule has none or was deleted.
  suggestion: z.string().nullable(),
  createdAt: TimestampSchema,
  refineRequestId: UuidSchema.nullable().optional(),
  refineClaimed: z.boolean().optional(),
  refineFailed: z.boolean().optional(),
});
export type PatternAlertView = z.infer<typeof PatternAlertViewSchema>;

export const PatternAlertListSchema = z.object({
  alerts: z.array(PatternAlertViewSchema),
});
export type PatternAlertList = z.infer<typeof PatternAlertListSchema>;

export const PATTERN_ACTIVE_RULE_LIMIT = 100;
export const PATTERN_PAGE_LIMIT = 100;
export const PatternRuleSectionSchema = z.enum(["all", "active", "disabled"]);
export const PatternAlertHistoryViewSchema = z.enum(["visible", "history"]);
// Keep the original fractional timestamp text so continuation does not round away microseconds.
export const PatternRuleCursorSchema = z
  .object({
    section: PatternRuleSectionSchema,
    active: z.boolean(),
    severity: PatternSeveritySchema,
    createdAt: TimestampSchema.max(40),
    id: UuidSchema,
  })
  .strict();
export type PatternRuleCursor = z.infer<typeof PatternRuleCursorSchema>;
export const PatternAlertCursorSchema = z
  .object({
    view: PatternAlertHistoryViewSchema,
    createdAt: TimestampSchema.max(40),
    id: UuidSchema,
  })
  .strict();
export type PatternAlertCursor = z.infer<typeof PatternAlertCursorSchema>;
export const PatternRulesPageInputSchema = z
  .object({
    section: PatternRuleSectionSchema.default("all"),
    limit: z.number().int().min(1).max(PATTERN_PAGE_LIMIT).default(50),
    cursor: PatternRuleCursorSchema.optional(),
  })
  .strict()
  .refine((input) => !input.cursor || input.cursor.section === input.section, {
    message: "Pattern rule cursor section mismatch",
    path: ["cursor"],
  });
export type PatternRulesPageInput = z.input<typeof PatternRulesPageInputSchema>;
export const PatternAlertsPageInputSchema = z
  .object({
    view: PatternAlertHistoryViewSchema.default("visible"),
    limit: z.number().int().min(1).max(PATTERN_PAGE_LIMIT).default(50),
    cursor: PatternAlertCursorSchema.optional(),
  })
  .strict()
  .refine((input) => !input.cursor || input.cursor.view === input.view, {
    message: "Pattern alert cursor view mismatch",
    path: ["cursor"],
  });
export type PatternAlertsPageInput = z.input<typeof PatternAlertsPageInputSchema>;

export const PatternRuleViewSchema = z.object({
  id: UuidSchema,
  kind: PatternRuleKindSchema,
  label: z.string().max(120),
  instruction: z.string().max(600),
  suggestion: z.string().max(600).nullable(),
  regex: z.string().max(300).nullable(),
  severity: PatternSeveritySchema,
  active: z.boolean(),
  source: PatternRuleSourceSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  admitted: z.boolean(),
});
export const PatternRulesPageSchema = z.object({
  rules: z.array(PatternRuleViewSchema).max(PATTERN_PAGE_LIMIT),
  nextCursor: PatternRuleCursorSchema.nullable(),
  total: z.number().int().nonnegative(),
  counts: z.object({
    active: z.number().int().nonnegative(),
    disabled: z.number().int().nonnegative(),
    malformedActive: z.number().int().nonnegative(),
  }),
});
export type PatternRulesPage = z.infer<typeof PatternRulesPageSchema>;
export const PatternAlertsPageSchema = z.object({
  alerts: z.array(PatternAlertViewSchema).max(PATTERN_PAGE_LIMIT),
  nextCursor: PatternAlertCursorSchema.nullable(),
  total: z.number().int().nonnegative(),
});
export type PatternAlertsPage = z.infer<typeof PatternAlertsPageSchema>;

/** Decode only a bounded transport cursor; its page-specific schema remains authoritative. */
export function decodePatternCursor(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    throw new Error("Invalid pattern page cursor");
  return JSON.parse(value);
}

// POST :id/refine — the operator's optional steer for the AI rewrite.
export const PatternRefineInputSchema = z.object({
  note: z.string().max(600).optional(),
  expectedRequestId: UuidSchema.optional(),
});
export type PatternRefineInput = z.infer<typeof PatternRefineInputSchema>;

export const PatternRefineResultSchema = z.object({
  ruleId: UuidSchema,
  instruction: z.string().min(8).max(600),
});
export type PatternRefineResult = z.infer<typeof PatternRefineResultSchema>;

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  MODEL_CATALOG,
  OrgMembershipError,
  handleForModel,
  type PersistedModelOverrides,
} from "@noelle/runtime";
import { DiscoveryConfigSchema, type DiscoveryConfig } from "@noelle/contracts";
import { sql } from "@/lib/db";
import { getCurrentUser, getOrgBySlug } from "@/lib/queries";
import { checkAdmin } from "@/lib/admin-gate";
import { agentSlug } from "@/lib/agent-route";

/**
 * Per-agent configuration save.
 *
 * What persists:
 *   - `budget_cap_cents` (server-clamped to [BUDGET_MIN, BUDGET_MAX])
 *   - `pending_drafts_cap` / `lead_backlog_cap` — backpressure caps from
 *     migrations 0012/0013. Empty input ⇒ NULL ⇒ "no cap"; positive int
 *     otherwise. The DB also enforces > 0 via CHECK, but we validate in
 *     the action so the user gets a friendly error instead of a 500.
 *   - `model_overrides` JSONB — per-worker map with backward-compat
 *     `primary`/`fallback` mirrored at the top level for the chat path that
 *     hasn't migrated to the worker-scoped shape yet.
 *
 *     Persisted shape:
 *       {
 *         primary:  { engine, model },          // mirrors drafter primary
 *         fallback: { engine, model } | null,   // mirrors drafter fallback
 *         workers: {
 *           classifier: { primary, fallback },
 *           drafter:    { primary, fallback }
 *         }
 *       }
 *
 *     Discovery and Send don't call LLMs — no entries for them.
 *
 * Drafter wiring: `apps/x-intern/src/lib/routing.ts` reads model_overrides.
 * Chat: `apps/app/src/app/api/agents/<id>/chat` still reads the legacy
 * `primary.model` so we keep the top-level mirror.
 *
 * Auth: sign-in + org membership + admin
 * (`noelle.invited_emails.is_admin = true`).
 */

const BUDGET_MIN_CENTS = 2_500;
const BUDGET_MAX_CENTS = 200_000;
const ALERT_PCT_MIN = 50;
const ALERT_PCT_MAX = 100;

// The form posts a bare model id; allowed ids derive from the catalog so
// adding a model in modelCatalog.ts widens picker + validator at once. The
// engine is resolved server-side (handleForModel) and never trusted from the
// client.
const ALL_MODEL_IDS = new Set(MODEL_CATALOG.map((m) => m.model));

const HandleStringSchema = z
  .string()
  .refine((v) => ALL_MODEL_IDS.has(v) || v === "none", {
    message: "Unknown model (not in catalog)",
  });

/**
 * Backpressure caps come in from a `<input type="number">`. An empty
 * input posts as an empty string — we treat that as "clear the cap"
 * and persist NULL. Anything that parses to a positive int passes; a
 * zero, negative, or non-numeric value fails validation.
 */
const PositiveIntOrNull = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((raw): number | null => {
    if (raw == null) return null;
    if (typeof raw === "string" && raw.trim() === "") return null;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return Number.NaN; // refine() catches this
    return Math.trunc(n);
  })
  .refine((n) => n === null || (Number.isInteger(n) && n > 0), {
    message: "Cap must be a positive integer or blank for no cap.",
  });

/**
 * Classifier q-score threshold (0-100). Blank ⇒ null ⇒ the worker uses the env
 * default (LINKEDIN_Q_THRESHOLD). 0 is valid (loosest); 100 is strictest.
 */
const ClassifierThresholdOrNull = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((raw): number | null => {
    if (raw == null) return null;
    if (typeof raw === "string" && raw.trim() === "") return null;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return Number.NaN; // refine() catches this
    return Math.trunc(n);
  })
  .refine((n) => n === null || (Number.isInteger(n) && n >= 0 && n <= 100), {
    message: "Classifier threshold must be an integer 0-100, or blank for the default.",
  });

// Resolve a posted model id to a full {engine, model} handle. The engine comes
// from the catalog (never the client), and we re-validate membership in the
// catalog here as defense in depth.
function parseHandle(value: string): { engine: string; model: string } | null {
  if (value === "none") return null;
  return handleForModel(value);
}

// Auto-send delay bounds match the slider UI on the config page. The
// max-delay floor (60s) and the max-per-hour cap (30) are deliberately
// Provider settings are validated before use.
const AUTO_SEND_DELAY_MIN_SEC = 30;
const AUTO_SEND_DELAY_MAX_SEC = 3600;
const AUTO_SEND_MAX_PER_HOUR_MIN = 1;
const AUTO_SEND_MAX_PER_HOUR_MAX = 30;

const FormSchema = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  budgetCapCents: z.coerce
    .number()
    .int()
    .min(BUDGET_MIN_CENTS)
    .max(BUDGET_MAX_CENTS),
  classifierPrimary: HandleStringSchema,
  classifierFallback: HandleStringSchema,
  drafterPrimary: HandleStringSchema,
  drafterFallback: HandleStringSchema,
  budgetAlertPct: z.coerce.number().int().min(ALERT_PCT_MIN).max(ALERT_PCT_MAX),
  escalateOnCap: z.boolean(),
  pauseOn5xx: z.boolean(),
  notifyLowConfidence: z.boolean(),
  autoSendEnabled: z.boolean(),
  autoDeferDms: z.boolean(),
  // 0036_dm_autodraft_enabled — auto-draft a cold-outreach DM alongside each
  // reply. Off by default (replies only); applies to both interns.
  dmAutodraft: z.boolean(),
  // 0039_linkedin_intro_dm_enabled — Lyra's one-time intro-DM lane. Off by
  // default; LinkedIn only (the toggle renders for Lyra; absent → false for X).
  linkedinIntroDm: z.boolean(),
  autoSendMinDelaySec: z.coerce
    .number()
    .int()
    .min(AUTO_SEND_DELAY_MIN_SEC)
    .max(AUTO_SEND_DELAY_MAX_SEC),
  autoSendMaxDelaySec: z.coerce
    .number()
    .int()
    .min(AUTO_SEND_DELAY_MIN_SEC)
    .max(AUTO_SEND_DELAY_MAX_SEC),
  autoSendMaxPerHour: z.coerce
    .number()
    .int()
    .min(AUTO_SEND_MAX_PER_HOUR_MIN)
    .max(AUTO_SEND_MAX_PER_HOUR_MAX),
  // Empty input from the dashboard ⇒ "" ⇒ null (no cap). Anything else
  // must be a positive integer.
  pendingDraftsCap: PositiveIntOrNull,
  leadBacklogCap: PositiveIntOrNull,
  // 0042 — classifier q-score threshold (0-100); blank ⇒ null (env default).
  classifierThreshold: ClassifierThresholdOrNull,
  // Discovery defaults (0032) — raw strings from the form; clamped + validated
  // into discovery_config by buildDiscoveryConfig() below.
  discWindowHours: z.string().optional(),
  discPostsPerSource: z.string().optional(),
  discMinFaves: z.string().optional(),
  discMinReplies: z.string().optional(),
  // LinkedIn (Lyra) engagement floors — minReactions doubles as the keyword
  // search lane's high-engagement floor; minComments filters the watch lane.
  discMinReactions: z.string().optional(),
  discMinComments: z.string().optional(),
  discExcludeRetweets: z.boolean(),
  discExcludeReplies: z.boolean(),
  discLang: z.string().optional(),
}).refine(
  (v) => v.autoSendMaxDelaySec >= v.autoSendMinDelaySec,
  {
    message: "autoSendMaxDelaySec must be >= autoSendMinDelaySec",
    path: ["autoSendMaxDelaySec"],
  },
);

function coerceBoolean(value: FormDataEntryValue | null): boolean {
  if (value === null) return false;
  if (typeof value !== "string") return false;
  return value === "true" || value === "on" || value === "1";
}

// Build the saved discovery default from the form's raw strings, clamping each
// field to the schema's bounds so a typo never 500s. Empty numeric → null
// ("no filter"); postsPerSource defaults to 20. The result is re-validated by
// DiscoveryConfigSchema before persisting.
function buildDiscoveryConfig(form: {
  discWindowHours?: string;
  discPostsPerSource?: string;
  discMinFaves?: string;
  discMinReplies?: string;

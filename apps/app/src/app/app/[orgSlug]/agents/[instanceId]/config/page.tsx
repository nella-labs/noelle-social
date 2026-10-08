import { AppLink as Link } from "@/components/nav/AppLink";
import { notFound, redirect } from "next/navigation";
import { Avatar } from "@/components/constellation/Avatar";
import { PageHeader } from "@/components/nav/PageHeader";
import { RangeWithLabel } from "./RangeWithLabel";
import { BudgetCapField } from "./BudgetCapField";
import { SavedToast } from "./SavedToast";
import { StepperField } from "./StepperField";
import { PercentPicker } from "./PercentPicker";
import { ConfigSideNav } from "./ConfigSideNav";
import { SwitchField } from "./SwitchField";
import { SaveBar } from "./SaveBar";
import {
  getAgentInstance,
  getInstanceSpendThisMonth,
  getOrgBySlug,
  listAgentInstancesForOrg,
} from "@/lib/queries";
import type { NoelleAgentInstance } from "@/lib/db-types";
import { DiscoveryConfigSchema } from "@noelle/contracts";
import { SOCIAL_CHANNELS, channelForRole } from "@/lib/social-channels";
import { formatCents } from "@/lib/utils";
import { checkAdmin } from "@/lib/admin-gate";
import { getPushoverConnection } from "@/lib/connections";
import { updateAgentConfig } from "./actions";
import { AGENT_UUID_RE, agentHref, matchAgentBySlug } from "@/lib/agent-route";
import { cleanModelLabel } from "@/lib/model-label";
import {
  MODEL_CATALOG,
  WORKER_DEFAULTS,
  resolveWorkerRoutingDisplay,
  catalogWinnerForModel,
  type CatalogEntry,
  type PersistedModelOverrides,
} from "@noelle/runtime";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; instanceId: string }>;
  searchParams: Promise<{ saved?: string }>;
}


// Budget slider — $25 minimum so users can't set a cap that bricks the
// agent on its first model call. $2,000 ceiling.
const BUDGET_MIN_CENTS = 2_500;
const BUDGET_MAX_CENTS = 200_000;
const BUDGET_STEP_CENTS = 500;

/**
 * Picker options derived from MODEL_CATALOG. The form posts a bare model id
 * (never the backend engine — that stays internal); the server action resolves
 * the engine via the same catalogWinnerForModel() the picker uses here. The
 * sort puts models recommended for this worker first.
 */
function optionsForWorker(
  worker: "classifier" | "drafter",
  includeNone: boolean,
): Array<{ value: string; label: string; hint?: string }> {
  // One option per model id — users pick a model, never a backend. Resolve
  // each model id to its single shown entry (prefer a wired "ready" engine
  // over a preview fallback) through the shared runtime helper so the picker
  // and the save action agree on the engine, and the engine never appears in
  // the form value.
  const models = [...new Set(MODEL_CATALOG.map((m) => m.model))];
  const entries = models
    .map((id) => catalogWinnerForModel(id))
    .filter((m): m is CatalogEntry => !!m);
  const sorted = entries.sort((a, b) => {
    const aRec = a.recommendedFor?.includes(worker) ? 0 : 1;
    const bRec = b.recommendedFor?.includes(worker) ? 0 : 1;
    if (aRec !== bRec) return aRec - bRec;
    return a.label.localeCompare(b.label);
  });
  const opts = sorted.map((m) => ({
    value: m.model,
    label: m.label + (m.status === "preview" ? " · preview" : ""),
    hint: m.hint,
  }));
  return includeNone
    ? [
        {
          value: "none",
          label: "None",
          hint: "If primary errors, this worker fails the run",
        },
        ...opts,
      ]
    : opts;
}

// The picker value is the bare model id (the engine is resolved server-side),
// so a saved handle maps to its model id for matching the selected radio.
function handleString(h?: { engine?: string; model?: string } | null): string {
  if (!h || !h.model) return "none";
  return h.model;
}

function catalogEntryFor(value: string): CatalogEntry | undefined {
  if (value === "none") return undefined;
  return catalogWinnerForModel(value);
}

/**
 * Agent configuration screen.
 *
 * Per-worker model routing: the X intern runs as a small pipeline (discovery
 * → classifier → drafter → send). Discovery + send don't call LLMs, but the
 * classifier and drafter do — and operators can pick which model each one
 * runs through, off the unified runtime MODEL_CATALOG. The choice persists
 * to `noelle.agent_instances.model_overrides.workers.<worker>` and is read
 * back by `resolveWorkerRouting` in the worker code on every tick.
 *
 * Admin-gated: only org admins (`noelle.invited_emails.is_admin = true`)
 * can change anything. Everyone else sees a read-only view.
 */
export default async function AgentConfigPage({
  params,
  searchParams,
}: PageProps) {
  const { orgSlug, instanceId } = await params;
  const { saved: savedToken = null } = await searchParams;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  // `instanceId` may be a UUID, a slug ("vega"), or a channel setup slug.
  let instance: NoelleAgentInstance | null = null;
  if (AGENT_UUID_RE.test(instanceId)) {
    instance = await getAgentInstance(instanceId);
    if (instance && instance.org_id !== org.id) notFound();
  } else {
    const orgAgents = await listAgentInstancesForOrg(org.id).catch(
      () => [] as NoelleAgentInstance[],
    );
    instance = matchAgentBySlug(orgAgents, instanceId);
  }

  if (!instance) {
    const channel = SOCIAL_CHANNELS.find(row => row.setupSlug === instanceId);
    if (!channel) notFound();
    const real = (await listAgentInstancesForOrg(org.id)).find(row => row.role === channel.role);
    if (real) redirect(agentHref(orgSlug, real, "config"));
    redirect(`/app/${orgSlug}/settings?tab=channels`);
  }
  const channel = channelForRole(instance.role);
  if (!channel) notFound();
  const designRole = channel.setupSlug;
  const displayName = instance.display_name ?? channel.label;
  const title = `${channel.label} preferences`;
  const rawCapCents = instance.budget_cap_cents ?? BUDGET_MIN_CENTS;
  // Floor the cap to the $25 minimum EVERYWHERE — the input, the "spent / cap"
  // line, and the percent all read this one value. Legacy rows can hold a
  // sub-floor cap (e.g. $5 from before the minimum existed); the input clamps
  // it up to $25 but the spent line used the raw value, so the card showed
  // "$3.65 / $5.00" under a "$25" input. One floored value keeps them in sync.
  // (Migration 0028 raises the stored value to match on next read.)
  const capCents = Math.max(rawCapCents, BUDGET_MIN_CENTS);
  // Live spend recorded against the cap this calendar month — surfaced next to
  // the control so the cap visibly relates to something real, not an abstract
  // number. Enforced before every model call by the three-layer pre-flight.
  const spentCents = await getInstanceSpendThisMonth(instance.id).catch(() => null);
  const budgetUsedPct =
    spentCents !== null && capCents > 0 ? Math.min(100, Math.round((spentCents / capCents) * 100)) : 0;
  const { isAdmin } = await checkAdmin();
  const canEdit = isAdmin;

  // Drive the per-worker pickers off the runtime resolver so the UI mirrors
  // what the workers actually run (including legacy `primary`/`fallback`
  // fallthrough for rows saved before per-worker pickers landed).
  const overrides =
    (instance?.model_overrides as PersistedModelOverrides | null) ?? null;
  const classifierRouting =
    resolveWorkerRoutingDisplay("classifier", overrides) ??
    WORKER_DEFAULTS.classifier!;
  const drafterRouting =
    resolveWorkerRoutingDisplay("drafter", overrides) ??
    WORKER_DEFAULTS.drafter!;
  const currentClassifierPrimary = handleString(classifierRouting.primary);
  const currentClassifierFallback = handleString(classifierRouting.fallback);
  const currentDrafterPrimary = handleString(drafterRouting.primary);
  const currentDrafterFallback = handleString(drafterRouting.fallback);

  const classifierPrimaryOpts = optionsForWorker("classifier", false);
  const classifierFallbackOpts = optionsForWorker("classifier", true);
  const drafterPrimaryOpts = optionsForWorker("drafter", false);
  const drafterFallbackOpts = optionsForWorker("drafter", true);

  // Policy defaults match the migration's column defaults.
  const alertPct = instance?.budget_alert_pct ?? 75;
  const escalateOnCap = instance?.escalate_on_cap ?? true;
  const pauseOn5xx = instance?.pause_on_5xx ?? true;
  const notifyLowConf = instance?.notify_low_confidence ?? false;
  // 0026_auto_defer_dms — off by default (operator parks DMs manually).
  const autoDeferDms = instance?.auto_defer_dms ?? false;
  // 0036_dm_autodraft_enabled — auto-draft a DM alongside each reply. Off by
  // default (replies only); applies to both interns.
  const dmAutodraftEnabled = instance?.dm_autodraft_enabled ?? false;
  // 0039_linkedin_intro_dm_enabled — Lyra's one-time intro-DM lane. Off by
  // default; LinkedIn (Lyra) only.

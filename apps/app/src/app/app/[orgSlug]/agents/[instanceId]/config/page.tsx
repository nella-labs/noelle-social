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
  const introDmEnabled = instance?.linkedin_intro_dm_enabled ?? false;

  // 0015_auto_send defaults: off + (120s, 660s) + 6/hr.
  const autoSendEnabled = instance?.auto_send_enabled ?? false;
  const autoSendMinDelay = instance?.auto_send_min_delay_sec ?? 120;
  const autoSendMaxDelay = instance?.auto_send_max_delay_sec ?? 660;
  const autoSendMaxPerHour = instance?.auto_send_max_per_hour ?? 6;

  // Backpressure caps: NULL on the DB row means "no cap" — render as an
  // empty input so the founder sees a blank field, not a 0 they'd have to
  // delete. The form action treats "" as null again on save.
  const pendingDraftsCap = instance?.pending_drafts_cap ?? null;
  const leadBacklogCap = instance?.lead_backlog_cap ?? null;
  // 0042 — per-instance classifier q-score threshold (0-100). NULL = env default.
  const classifierThreshold = instance?.classifier_threshold ?? null;

  // Discovery defaults (0032). Bird-operator tailoring is X-only, so the section
  // is gated to x_intern. Bad/empty jsonb degrades to {} (worker defaults).
  const isXIntern = (instance?.role ?? "") === "x_intern";
  const isLinkedinIntern = (instance?.role ?? "") === "linkedin_intern";
  const isRedditIntern = (instance?.role ?? "") === "reddit_intern";
  const discParsed = DiscoveryConfigSchema.safeParse(
    (instance as { discovery_config?: unknown } | null)?.discovery_config ?? {},
  );
  const disc = discParsed.success ? discParsed.data : {};

  // Whether Pushover is actually wired — env keys (self-host) or Secret
  // Manager (hosted). When it isn't, the alert toggles below silently no-op,
  // so availability is shown beside the alert settings.
  const pushover = await getPushoverConnection(org.id);
  const connectionsHref = `/app/${orgSlug}/connections`;

  const saveHelpCopy = !isAdmin
    ? "Only workspace admins can change channel preferences."
    : "Changes apply to the next run.";

  return (
    <>
      <SavedToast token={savedToken} />
      <PageHeader
        eyebrow={`${title} · configure`}
        title={
          <>
            <em>{displayName}</em> · settings
          </>
        }
        sub="Pick a model for each worker. Discovery and Send don't call LLMs; Classifier and Drafter run through the model you choose, billed against the catalog price."
        right={
          <Link
            href={instance ? agentHref(orgSlug, instance) : `/app/${orgSlug}/agents/${instanceId}`}
            className="btn btn-sm btn-ghost"
          >
            ← Back to agent
          </Link>
        }
      />

      <form
        action={updateAgentConfig}
        className="stack-phone"
        style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 24, alignItems: "start" }}
      >
        {/* The save action writes by instance UUID — never the URL slug. */}
        <input type="hidden" name="instanceId" value={instance?.id ?? instanceId} />
        <input type="hidden" name="orgSlug" value={orgSlug} />

        <aside className="hide-phone" style={{ position: "sticky", top: 16, alignSelf: "start" }}>
          <div className="card" style={{ padding: 18 }}>
            <div className="eyebrow" style={{ marginBottom: 12 }}>
              Configure
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 14,
              }}
            >
              <Avatar role={designRole} size={32} />
              <div>
                <div style={{ fontFamily: "var(--display)", fontSize: 17, lineHeight: 1 }}>
                  {displayName}
                </div>
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    color: "var(--ink-muted)",
                    marginTop: 3,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}
                >
                  {title}
                </div>
              </div>
            </div>
            <hr className="rule-soft" style={{ margin: "0 0 10px" }} />
            <ConfigSideNav
              items={[
                { id: "routing", label: "Worker routing" },
                { id: "byo-keys", label: "Bring your own key" },
                { id: "budget", label: "Budget cap" },
                { id: "auto-send", label: "Auto-send" },
                { id: "dms", label: "Direct messages" },
                ...(isXIntern || isLinkedinIntern || isRedditIntern ? [{ id: "classifier", label: "Classifier filter" }] : []),
                ...(isXIntern || isLinkedinIntern || isRedditIntern ? [{ id: "discovery", label: "Discovery" }] : []),
                { id: "backpressure", label: "Pipeline caps" },
                { id: "alerts", label: "Alerts" },
                { id: "escalation", label: "Escalation rules" },
              ]}
            />
          </div>
        </aside>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <CfgSection
            id="routing"
            title="Worker routing"
            sub="Each agent runs as a small pipeline. Pick the model each step calls through. Preview-tagged models are saved as your intent but currently run on our default managed model until that option ships."
          >
            <WorkerCard
              label="Discovery"
              role="No LLM — polls X public-search APIs for new leads."
              stage="0.0.1"
            />

            <WorkerCard
              label="Classifier"
              role="Decides whether a lead is on-brand and assigns a quality score that feeds the inbox filter."
              stage="0.0.1"
            >
              <CfgRow
                label="Primary"
                hint="What the classifier runs on every new lead. Default is Haiku 4.5 — cheap and quick."
              >
                <ModelPills
                  name="classifierPrimary"
                  defaultValue={currentClassifierPrimary}
                  options={classifierPrimaryOpts}
                  disabled={!canEdit}
                />
              </CfgRow>
              <CfgRow
                label="Fallback"
                hint="Used automatically on rate-limit or 5xx. None means the classifier passes the lead through unscored."
              >
                <ModelPills
                  name="classifierFallback"
                  defaultValue={currentClassifierFallback}
                  options={classifierFallbackOpts}
                  disabled={!canEdit}
                />
              </CfgRow>
              <PriceLine
                handle={currentClassifierPrimary}
                fallback={currentClassifierFallback}
              />
            </WorkerCard>

            <WorkerCard
              label="Drafter"
              role="Writes the three angles per classified lead. Drives draft cost more than any other step."
              stage="0.0.1"
            >
              <CfgRow
                label="Primary"
                hint="What the drafter calls per lead. Sonnet 4.6 is the cheapest model that ships on-brand drafts at scale."
              >
                <ModelPills
                  name="drafterPrimary"
                  defaultValue={currentDrafterPrimary}
                  options={drafterPrimaryOpts}
                  disabled={!canEdit}
                />
              </CfgRow>
              <CfgRow
                label="Fallback"
                hint="Used on rate-limit or 5xx. Opus is ~5× the cost — keep as the escalation, not the default."
              >
                <ModelPills
                  name="drafterFallback"
                  defaultValue={currentDrafterFallback}
                  options={drafterFallbackOpts}
                  disabled={!canEdit}
                />
              </CfgRow>
              <PriceLine
                handle={currentDrafterPrimary}
                fallback={currentDrafterFallback}
              />
            </WorkerCard>

            <WorkerCard
              label="Send"
              role="No LLM — posts the approved draft through the operator's X OAuth token."
              stage="0.0.1"
            />
          </CfgSection>

          <CfgSection
            id="byo-keys"
            title="Bring your own key"
            sub="Use your own provider API keys instead of Noelle's pool. Calls billed to your account skip Noelle's spend recorder. This card persists in the next release — adding keys today is not yet possible."
          >
            <ByoKeysGrid disabled />
          </CfgSection>

          <CfgSection
            id="budget"
            title="Budget cap"
            sub="Hard cap enforced before each model call by the three-layer pre-flight check."
          >
            <CfgRow
              label="Monthly cap"
              hint={`Total spend allowed for this agent per calendar month. Minimum $${BUDGET_MIN_CENTS / 100}.`}
            >
              <BudgetCapField
                defaultCents={capCents}
                minCents={BUDGET_MIN_CENTS}
                maxCents={BUDGET_MAX_CENTS}
                stepCents={BUDGET_STEP_CENTS}
                disabled={!canEdit}
              />
              {!canEdit ? (
                <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 6 }}>
                  Only workspace admins can change the cap.
                </div>
              ) : null}
            </CfgRow>
            <CfgRow
              label="Spent this month"
              hint="Live spend recorded against this cap. The agent stops calling models for the rest of the month once spend reaches the cap."
            >
              <span style={{ fontFamily: "var(--mono)", fontSize: 13 }}>
                {spentCents === null ? "Unavailable" : formatCents(spentCents)} / {formatCents(capCents)}
                <span style={{ color: "var(--ink-muted)" }}> · {budgetUsedPct}% used</span>
              </span>
            </CfgRow>
          </CfgSection>

          <CfgSection
            id="auto-send"
            title="Auto-send"
            sub={
              isRedditIntern
                ? "When on, the Reddit actuator auto-sends approved replies — posting from your logged-in reddit.com tab. A reply in the approvals queue IS the approval; Skip it to stop it. Send pacing (spacing, per-hour cap, warm-up, curfew) lives in the actuator, not here."
                : "When on, Vega picks the longest of the three angles, schedules it for delayed delivery, and posts to X without waiting for your approval. The other two angles are skipped automatically so they don't clutter the inbox. The send worker holds the post until target time, then fires through the same path your manual Send click uses."
            }
          >
            <CfgRow
              label="Auto-send mode"
              hint={
                isRedditIntern
                  ? "Off (default): replies wait in the approvals queue. On: the Reddit actuator posts approved replies automatically."
                  : "Off (default): three angles land in the inbox for human review. On: Vega ships replies on the schedule below."
              }
            >
              <SwitchField
                name="autoSendEnabled"
                defaultChecked={autoSendEnabled}
                disabled={!canEdit}
              />
            </CfgRow>
            {/* The delay/rate knobs below drive the X send WORKER's delayed
                delivery. Orion has no send worker — the Reddit actuator posts and
                paces itself (see docs/reddit-actuator.md) — so they don't apply. */}
            {!isRedditIntern && (
              <>
                <CfgRow
                  label="Earliest delay"
                  hint="Minimum wall-clock wait between drafter creation and X post. 120s = 1 min base + 1 min jitter; bumping this padds out the cadence."
                >
                  <RangeWithLabel
                    name="autoSendMinDelaySec"
                    min={30}
                    max={1800}
                    step={30}
                    defaultValue={autoSendMinDelay}
                    disabled={!canEdit}
                    format="duration"
                  />
                </CfgRow>
                <CfgRow
                  label="Latest delay"
                  hint="Upper bound on the wait. Each reply rolls uniform(earliest, latest) then scales 0.5×–1.5× by the prior body's length so a long reply pads the next; a short reply doesn't."
                >
                  <RangeWithLabel
                    name="autoSendMaxDelaySec"
                    min={60}
                    max={3600}
                    step={30}
                    defaultValue={autoSendMaxDelay}
                    disabled={!canEdit}
                    format="duration"
                  />
                </CfgRow>
                <CfgRow
                  label="Max per hour"
                  hint="Rate brake. When the trailing-hour auto-send count hits this number, the send worker leaves due rows for the next tick instead of bursting them out."
                >
                  <StepperField
                    name="autoSendMaxPerHour"
                    min={1}
                    max={30}
                    step={1}
                    defaultValue={autoSendMaxPerHour}
                    disabled={!canEdit}
                    unitLabel="/hr"
                  />
                </CfgRow>
              </>
            )}
          </CfgSection>

          <CfgSection
            id="dms"
            title="Direct messages"
            sub="When on, the drafter auto-drafts a cold-outreach DM alongside each reply (queued for approval — never auto-sent). Off by default: replies only, which keeps the approval queue focused on comments."
          >
            <CfgRow
              label="Auto-draft DMs"
              hint="Off (default): the drafter generates replies only. On: a DM draft is added per qualifying lead. You still send every DM by hand."
            >
              <SwitchField
                name="dmAutodraft"
                defaultChecked={dmAutodraftEnabled}
                disabled={!canEdit}
              />
            </CfgRow>
            {isLinkedinIntern ? (
              <CfgRow
                label="Intro DMs"
                hint="Off (default): no intro DMs. On: Lyra drafts ONE warm relationship intro DM per profiled connection, ever (no pitch — queued for approval, never auto-sent). Never runs during a goal-run."
              >
                <SwitchField
                  name="linkedinIntroDm"
                  defaultChecked={introDmEnabled}
                  disabled={!canEdit}
                />
              </CfgRow>
            ) : null}
          </CfgSection>

          {isXIntern || isLinkedinIntern || isRedditIntern ? (
            <CfgSection
              id="classifier"
              title="Classifier filter"
              sub={`How strict the intern is about which posts are worth a reply. The classifier scores each post 0–100 for reply-worthiness; posts at or above the threshold get drafted, below it are skipped (or get a short note). Lower = looser (more drafts, lower precision). Blank = the default (${isXIntern ? 50 : 75}).`}
            >
              <CfgRow
                label="Quality threshold (0–100)"
                hint={`A post scoring at or above this becomes a draft. Blank = ${isXIntern ? 50 : 75} (platform default). Try lowering it to loosen the filter when the approval queue is thin.`}
              >
                <DiscNumInput
                  name="classifierThreshold"
                  defaultValue={classifierThreshold}
                  disabled={!canEdit}
                  placeholder={isXIntern ? "50" : "75"}
                  min={0}
                  max={100}
                />
              </CfgRow>
            </CfgSection>
          ) : null}

          {isXIntern ? (
            <CfgSection
              id="discovery"
              title="Discovery"
              sub="The default for which posts discovery pulls each run. Override per-run from the agent's Pipeline panel (Start all → Tailor this run). Engagement, post-type, and language filters apply to keyword search only; the time window + posts-per-source apply to handle polling too."
            >
              <CfgRow
                label="Posts from the last (hours)"
                hint="Only ingest posts newer than this many hours. Blank = no window (any age). Applies to both watched handles and keyword search."
              >
                <DiscNumInput name="discWindowHours" defaultValue={disc.timeWindowHours ?? null} disabled={!canEdit} placeholder="No window" min={1} max={168} />
              </CfgRow>
              <CfgRow
                label="Posts per source"
                hint="How many tweets to pull per watched handle / keyword each tick. Blank = 20 (the default). Range 5–100."
              >
                <DiscNumInput name="discPostsPerSource" defaultValue={disc.postsPerSource ?? null} disabled={!canEdit} placeholder="20" min={5} max={100} />
              </CfgRow>
              <CfgRow
                label="Min likes (keyword search)"
                hint="Drop keyword-search posts below this like count (X min_faves:). Blank = no floor. Doesn't affect watched handles."
              >
                <DiscNumInput name="discMinFaves" defaultValue={disc.minFaves ?? null} disabled={!canEdit} placeholder="No floor" min={0} max={1000000} />
              </CfgRow>
              <CfgRow
                label="Min replies (keyword search)"
                hint="Drop keyword-search posts below this reply count (X min_replies:). Blank = no floor."
              >
                <DiscNumInput name="discMinReplies" defaultValue={disc.minReplies ?? null} disabled={!canEdit} placeholder="No floor" min={0} max={1000000} />
              </CfgRow>
              <CfgRow
                label="Exclude retweets (keyword search)"
                hint="Drop native retweets from keyword search (X -filter:nativeretweets)."

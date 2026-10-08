import { AppLink as Link } from "@/components/nav/AppLink";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/nav/PageHeader";
import {
  getOrgBySlug,
  getAgentInstance,
  listAgentInstancesForOrg,
  listPatternRules,
  listVisiblePatternAlerts,
} from "@/lib/queries";
import { AGENT_UUID_RE, matchAgentBySlug } from "@/lib/agent-route";
import { PatternRuleSection } from "./PatternRuleSection";
import { PatternAlertHistory } from "./PatternAlertHistory";
import {
  PATTERN_ACTIVE_RULE_LIMIT,
  PatternRulesPageInputSchema,
  PatternAlertsPageInputSchema,
  decodePatternCursor,
} from "@noelle/contracts";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; instanceId: string }>;
  searchParams: Promise<{ activeCursor?: string; disabledCursor?: string; alertCursor?: string }>;
}

/**
 * Pattern Breaker management panel. The breaker auto-learns writing habits the
 * operator over-uses across recent posts and stores them as noelle.pattern_rules;
 * the drafter injects the ACTIVE ones so the writer breaks the habit. Left
 * unattended the auto-rules pile up (25+ active on a busy intern) and some of
 * them over-formalize the voice — this surface lets the operator SEE every
 * flagged rule and turn individual ones off (or back on). Resolution mirrors the
 * feeder subpage: UUID or slug → real instance, then org match.
 */
export default async function PatternsPage({ params, searchParams }: PageProps) {
  const { orgSlug, instanceId } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  const instance = AGENT_UUID_RE.test(instanceId)
    ? await getAgentInstance(instanceId)
    : matchAgentBySlug(await listAgentInstancesForOrg(org.id).catch(() => []), instanceId);
  if (!instance || instance.org_id !== org.id) notFound();

  const resolvedInstanceId = instance.id;
  const query = await searchParams;
  const baseHref = `/app/${orgSlug}/agents/${instanceId}/patterns`;
  async function readRules(section: "active" | "disabled", cursor?: string) {
    try {
      return await listPatternRules(
        resolvedInstanceId,
        PatternRulesPageInputSchema.parse({
          section,
          ...(cursor === undefined ? {} : { cursor: decodePatternCursor(cursor) }),
        }),
      );
    } catch {
      return null;
    }
  }
  const [active, disabled, history] = await Promise.all([
    readRules("active", query.activeCursor),
    readRules("disabled", query.disabledCursor),
    (async () => {
      try {
        return await listVisiblePatternAlerts(
          resolvedInstanceId,
          PatternAlertsPageInputSchema.parse({
            view: "history",
            ...(query.alertCursor === undefined
              ? {}
              : { cursor: decodePatternCursor(query.alertCursor) }),
          }),
        );
      } catch {
        return null;
      }
    })(),
  ]);
  function nextHref(key: string, cursor: unknown) {
    const values = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) if (value) values.set(name, value);
    values.set(key, JSON.stringify(cursor));
    return `${baseHref}?${values}`;
  }
  const rulesHeld =
    active &&
    (active.counts.active > PATTERN_ACTIVE_RULE_LIMIT ||
      active.counts.malformedActive > 0 ||
      active.rules.some((rule) => !rule.admitted));

  return (
    <>
      <PageHeader
        eyebrow="Pattern Breaker"
        title={
          <>
            Writing habits <em>{instance.display_name ?? "the intern"}</em> is told to break
          </>
        }
        sub="The Pattern Breaker scans recent replies and records repeated writing habits. Drafting proceeds when the complete active rule set is valid and available. Disable a rule here to stop applying it on the next tick."
        right={
          <Link href={`/app/${orgSlug}/agents/${instanceId}`} className="btn btn-sm">
            ← Back to agent
          </Link>
        }
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {rulesHeld ? (
          <p role="status" className="card">
            Drafting is held because the active rules exceed {PATTERN_ACTIVE_RULE_LIMIT} or contain
            an invalid rule. Disable excess or invalid rules, then the next tick can load the
            complete set.
          </p>
        ) : null}
        <PatternRuleSection
          title="Active rules"
          count={active?.counts.active ?? null}
          page={active}
          empty="No active rules in this verified page."
          orgSlug={orgSlug}
          instanceId={resolvedInstanceId}
          nextHref={active?.nextCursor ? nextHref("activeCursor", active.nextCursor) : null}
        />
        <PatternRuleSection
          title="Disabled rules"
          count={disabled?.counts.disabled ?? null}
          page={disabled}
          empty="No disabled rules in this verified page."
          orgSlug={orgSlug}
          instanceId={resolvedInstanceId}
          nextHref={disabled?.nextCursor ? nextHref("disabledCursor", disabled.nextCursor) : null}
        />
        <PatternAlertHistory
          page={history}
          nextHref={history?.nextCursor ? nextHref("alertCursor", history.nextCursor) : null}
        />
      </div>
    </>
  );
}

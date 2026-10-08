"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import { withTx } from "@/lib/db";
import {
  setPatternRuleActiveInTx,
  validPatternScope,
  type PatternScope,
} from "@noelle/runtime/pattern-breaker-db";
import { getAgentInstance, getCurrentUser, getOrgBySlug } from "@/lib/queries";

// Server action for the Pattern Breaker management panel: flip one learned
// rule's `active` flag. The breaker auto-generates noelle.pattern_rules from the
// operator's recent posts and injects the ACTIVE ones into the drafter prompt —
// but a run of auto-rules (capitalize I, break run-ons, ban casual markers) can
// over-formalize the voice, so the operator needs a place to turn individual
// rules off (or back on) without waiting for the one-at-a-time approvals popup.
//
// Mirrors the feeder toggle: validate → authorize the instance in the caller's
// org (getAgentInstance runs assertOrgMember on the row's real org_id, the
// cross-tenant IDOR guard) → UPDATE org+instance-scoped → revalidate the route
// PATTERN so both slug + UUID cached variants refresh.

const AGENT_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]";
const PATTERNS_PAGE_ROUTE = "/app/[orgSlug]/agents/[instanceId]/patterns";

/**
 * Authorize a write against a specific instance the caller belongs to. The
 * Pattern rules belong to a current supported intern and an authorized organization.
 * The shared mutation rechecks that parent and membership while holding its transaction lock.
 */
async function authorizeInstance(orgSlug: string, instanceId: string) {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" as const };
  try {
    const org = await getOrgBySlug(orgSlug);
    if (!org) return { kind: "not_found" as const };
    const instance = await getAgentInstance(instanceId);
    if (!instance || instance.org_id !== org.id) return { kind: "not_found" as const };
    const scope = {
      orgId: org.id,
      agentInstanceId: instanceId,
      role: instance.role as PatternScope["role"],
      userId: user.id,
    };
    if (!validPatternScope(scope)) return { kind: "not_found" as const };
    return { kind: "ok" as const, scope };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { kind: "forbidden" as const };
    throw err;
  }
}

const SetActiveInput = z.object({
  orgSlug: z.string().min(1),
  instanceId: z.string().uuid(),
  ruleId: z.string().uuid(),
  active: z.boolean(),
});

/**
 * Enable / disable one learned pattern rule. Disabling drops it from the drafter
 * prompt on the next tick (the drafter only loads `where active`); enabling adds
 * it back. In the same transaction we sync the rule's linked alert so the
 * approvals popup and this panel never contradict: disabling reverts the alert
 * (identical to the popup's Revert), enabling marks it acknowledged.
 *
 * Re-enabling can collide with the unique partial index on
 * (agent_instance_id, lower(label)) WHERE active — the disabled set holds
 * superseded duplicates of active labels. We surface that as `label_conflict`
 * rather than letting the txn throw, so the operator can disable the other one
 * first instead of silently clobbering it.
 */
export async function setPatternRuleActive(input: z.infer<typeof SetActiveInput>) {
  const parsed = SetActiveInput.parse(input);
  const auth = await authorizeInstance(parsed.orgSlug, parsed.instanceId);
  if (auth.kind !== "ok") return { ok: false as const, error: auth.kind };

  try {
    const changed = await withTx((tx) =>
      setPatternRuleActiveInTx(tx, auth.scope, parsed.ruleId, parsed.active),
    );
    if (!changed) return { ok: false as const, error: "not_found" as const };
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
      return { ok: false as const, error: "label_conflict" as const };
    }
    throw err;
  }

  revalidatePath(AGENT_PAGE_ROUTE, "page");
  revalidatePath(PATTERNS_PAGE_ROUTE, "page");
  return { ok: true as const, active: parsed.active };
}

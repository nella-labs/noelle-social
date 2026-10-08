import "server-only";

/**
 * One entry point both guided surfaces call — the dashboard root and the
 * `/onboarding` hub — so they can never disagree about what step you are on.
 */

import { countPendingApprovalsAcrossAgents, getXApiConnection } from "@/lib/queries";
import { buildGuidedPlan } from "./plan";
import { isGuidedDismissed } from "./dismissal";
import { loadGuidedSignals } from "./signals";
import type { GuidedSetup } from "./types";

export async function loadGuidedSetup(args: {
  orgId: string;
  orgSlug: string;
}): Promise<GuidedSetup> {
  const { orgId, orgSlug } = args;

  const dismissed = await isGuidedDismissed(orgSlug).catch(() => false);
  try {
    const [pendingApprovals, xApi] = await Promise.all([
      countPendingApprovalsAcrossAgents(orgId), getXApiConnection(orgId),
    ]);
    const signals = await loadGuidedSignals({ orgId, pendingApprovals, xPostingReady: Boolean(xApi.connected) });
    return { status: "ready", plan: buildGuidedPlan(signals, orgSlug), dismissed };
  } catch {
    return { status: "unavailable", dismissed };
  }
}

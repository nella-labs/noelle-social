/**
 * Resolves the guided step registry against a signal snapshot.
 *
 * Pure by design. Every decision the guided UI makes is made here, against plain
 * objects, so the whole flow is testable without a database or a browser.
 *
 * Deliberately contains no `redirect()`. The flow this replaces hard-redirected
 * the dashboard root into the vault wizard, which caused an infinite loop on
 * Next 15 (see the scar comment in `app/[orgSlug]/layout.tsx`). The guided panel
 * renders inline instead, so that class of bug is structurally impossible here.
 */

import { GUIDED_STEPS, guidedCaveats, hiredInterns } from "./registry";
import type {
  GuidedPlan,
  GuidedSignals,
  GuidedStepState,
  GuidedStepView,
} from "./types";

/**
 * Resolve one step's state, ignoring "is it next?" — that is a whole-plan
 * question answered in `buildGuidedPlan`.
 */
function resolveState(
  step: (typeof GUIDED_STEPS)[number],
  signals: GuidedSignals,
): { state: Exclude<GuidedStepState, "current">; reason: string | null } {
  if (step.isComplete(signals)) return { state: "done", reason: null };

  const blocked = step.blockedBy?.(signals) ?? null;
  if (blocked) return { state: "blocked", reason: blocked };

  const waiting = step.waitingOn?.(signals) ?? null;
  if (waiting) return { state: "waiting", reason: waiting };

  return { state: "todo", reason: step.note?.(signals) ?? null };
}

function statusLine(
  signals: GuidedSignals,
  views: GuidedStepView[],
  complete: boolean,
): string {
  if (complete) {
    return "Required setup is complete. Check Engage for new drafts.";
  }

  // The step the operator can act on outranks everything else. Without this, an
  // `advanced` step sitting in `waiting` (e.g. publishing, once reply sending is
  // on) would hijack the line and tell someone about X cookies while they still
  // have no Apify token.
  const current = views.find((v) => v.state === "current");
  if (current) return current.step.blurb;

  if (signals.pendingApprovals > 0) {
    const n = signals.pendingApprovals;
    return `${n} draft${n === 1 ? "" : "s"} waiting on you in Approvals.`;
  }

  // Nothing to click. A required step that is waiting on the pipeline explains
  // the silence; an advanced one is a footnote, so it only speaks last.
  const waiting =
    views.find((v) => v.state === "waiting" && v.step.tier === "required") ??
    views.find((v) => v.state === "waiting");
  if (waiting?.reason) return waiting.reason;

  return "Pick up where you left off.";
}

export function buildGuidedPlan(signals: GuidedSignals, orgSlug: string): GuidedPlan {
  const resolved = GUIDED_STEPS.map((step) => {
    const { state, reason } = resolveState(step, signals);
    return { step, state, reason, href: step.href(orgSlug, signals) };
  });

  // Exactly one step is `current`: the first REQUIRED step the operator can act
  // on right now. `blocked` and `waiting` steps are excluded — there is nothing
  // to click — and so are `recommended`/`advanced` ones, which never claim the
  // operator's attention ahead of a required step.
  const currentIdx = resolved.findIndex(
    (v) => v.step.tier === "required" && v.state === "todo",
  );

  const steps: GuidedStepView[] = resolved.map((v, i) =>
    i === currentIdx ? { ...v, state: "current" as const } : v,
  );

  const required = steps.filter((v) => v.step.tier === "required");
  const requiredDone = required.filter((v) => v.state === "done").length;
  const complete = requiredDone === required.length;

  return {
    steps,
    requiredDone,
    requiredTotal: required.length,
    complete,
    currentId: currentIdx === -1 ? null : steps[currentIdx].step.id,
    status: statusLine(signals, steps, complete),
    caveats: guidedCaveats(signals),
  };
}

/** True when the panel has nothing useful left to say. */
export function shouldHideGuidedPanel(plan: GuidedPlan): boolean {
  return plan.complete && plan.caveats.length === 0;
}

export { hiredInterns };

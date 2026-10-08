import type { ActionableLinkedInResponse } from "@noelle/contracts";
import type { Rng } from "../lib/rng.js";
import { planDrainTimeline } from "../lib/scheduler.js";
import type { RunState } from "./state.js";
import { mergePool, shouldExtendDrain, type PoolItem } from "./replenish.js";

export const priorityTickDecision = (tickInFlight: boolean): "defer" | "tick" => tickInFlight ? "defer" : "tick";

/** Use the time the request began: anything approved while it was in flight
 * remains newer than the next cursor, even if the response arrives much later. */
export function advancePriorityCursor(previous: number, requestStartedAt: number, _responseAt: number): number {
  return Math.max(previous, requestStartedAt);
}

export async function isApprovalStillActionable(
  api: { fetchQueue(): Promise<{ comments: Array<{ approval_id: string }>; dms: Array<{ approval_id: string }> }> },
  kind: "comment" | "dm",
  approvalId: string,
): Promise<boolean> {
  try {
    const queue = await api.fetchQueue();
    return (kind === "comment" ? queue.comments : queue.dms).some((item) => item.approval_id === approvalId);
  } catch {
    return false;
  }
}

/** Any uncertain claim response blocks the browser send. The server reservation
 * may have succeeded before the response was lost, so retry only the claim. */
export async function claimCommentForSend(
  api: { claimComment(id: string): Promise<{ claimed: boolean }> },
  approvalId: string,
): Promise<"claimed" | "already-claimed" | "unavailable"> {
  try {
    const result = await api.claimComment(approvalId);
    return result.claimed ? "claimed" : "already-claimed";
  } catch {
    return "unavailable";
  }
}

export type WithheldApproval =
  | { kind: "retry"; reason: string }
  | { kind: "drop"; terminal: boolean; reason: string };

/** Queue absence can mean a temporary server gate or a decided approval.
 * Only the tenant-checked approval state can distinguish those cases. */
export async function classifyWithheldApproval(
  api: { fetchApprovalState(id: string): Promise<{ status: string; autosend_pending: boolean }> },
  approvalId: string,
): Promise<WithheldApproval> {
  try {
    const state = await api.fetchApprovalState(approvalId);
    if (state.status === "pending" && !state.autosend_pending) return { kind: "retry", reason: "pending" };
    if (state.autosend_pending) return { kind: "drop", terminal: false, reason: "autosend-owned" };
    const terminal = ["sent", "skipped", "expired", "errored"].includes(state.status);
    return { kind: "drop", terminal, reason: state.status };
  } catch {
    return { kind: "retry", reason: "state-unavailable" }; // fail closed, bounded below
  }
}

/** Retry a pending/unknown queue omission briefly; then let ordinary server
 * replenishment decide if it is eligible again, without wedging the local drain. */
export function restoreWithheldItem(pool: PoolItem[], item: PoolItem, runCurrent: boolean, maxChecks = 3): boolean {
  if (!runCurrent) return false;
  if (pool.some((entry) => entry.approvalId === item.approvalId)) return true;
  item.withheldChecks = (item.withheldChecks ?? 0) + 1;
  if (item.withheldChecks >= maxChecks) return false;
  pool.unshift(item);
  return true;
}

export function integratePriorityReady(
  state: RunState,
  comments: ActionableLinkedInResponse["comments"],
  now: number,
  rng: Rng,
): number {
  if (state.status !== "running") return 0;
  const before = state.commentPool.length;
  state.commentPool = mergePool(state.commentPool, comments.map((c) => ({
    approvalId: c.approval_id,
    draftId: c.draft_id,
    body: c.body,
    url: c.target.url,
    commentUrn: c.target.comment_urn ?? null,
    commentAuthorName: c.target.comment_author_name ?? null,
  })), new Set(state.doneDraftIds));
  const added = state.commentPool.length - before;
  if (added === 0 || !state.actions.every((a) => a.executed) ||
      !shouldExtendDrain(state.mode, state.drainRounds ?? 0, state.commentPool.length)) return added;

  // The wake only supplies the existing scheduler. It never performs a send.
  // When the previous comment just landed, honor the drain's 60-second floor.
  const startMs = Math.max(now, (state.lastProgressMs ?? 0) + 60_000);
  const planned = planDrainTimeline({
    approvedComments: state.commentPool.length,
    startMs,
    rng,
    ...(state.drainStyle ?? {}),
  });
  for (const action of planned) state.actions.push({ ...action, executed: false });
  const lastAt = planned.reduce((latest, action) => Math.max(latest, action.atMs), startMs);
  state.windowHours = (lastAt - state.startMs) / 3600_000 + 0.15;
  state.targets.comments += state.commentPool.length;
  state.targets.likes += planned.filter((action) => action.kind === "like").length;
  state.drainRounds = (state.drainRounds ?? 0) + 1;
  state.lastEvent = `priority reply ready — ${added} added at next scheduled slot`;
  return added;
}

import type { SpeedrunDraft } from "@/components/approvals/SpeedrunRow";
import type { LinkedInApprovalView, PendingApprovalRow } from "@/lib/queries";
import { draftPayload } from "@/lib/payload-shapes";
import { isLinkedInReplyReady, isXReplyReady } from "@/lib/reply-readiness";

export function isXApprovalDm(row: PendingApprovalRow): boolean {
  return draftPayload(row.draft).kind === "dm";
}

function xGroupKey(row: PendingApprovalRow): string {
  return row.approval.lead_id ?? row.draft?.lead_id ?? row.approval.id;
}

function linkedInGroupKey(row: LinkedInApprovalView): string {
  return `${row.authorPublicId ?? row.authorName}::${row.postUrl ?? row.postText ?? row.approvalId}`;
}

function visibleReviewRows<T>(
  rows: T[],
  showDms: boolean,
  isDm: (row: T) => boolean,
  groupKey: (row: T) => string,
  isReady: (row: T) => boolean,
): T[] {
  const seen = new Map<string, number>();
  const visible: T[] = [];
  for (const row of rows) {
    const dm = isDm(row);
    if (dm && !showDms) continue;
    const key = `${groupKey(row)}::${dm ? "dm" : "reply"}`;
    const index = seen.get(key);
    if (index !== undefined) {
      if (!isReady(visible[index]) && isReady(row)) visible[index] = row;
      continue;
    }
    seen.set(key, visible.length);
    visible.push(row);
  }
  return visible;
}

/** One reply and, when enabled, one DM per X lead. */
export function visibleXReviewRows(
  rows: PendingApprovalRow[],
  showDms: boolean,
): PendingApprovalRow[] {
  return visibleReviewRows(rows, showDms, isXApprovalDm, xGroupKey, isXReplyReady);
}

/** One reply and, when enabled, one DM per LinkedIn source post. */
export function visibleLinkedInReviewRows(
  rows: LinkedInApprovalView[],
  showDms: boolean,
  voiceFloor: number | null = 0.7,
): LinkedInApprovalView[] {
  return visibleReviewRows(rows, showDms, (row) => row.kind === "dm", linkedInGroupKey,
    (row) => isLinkedInReplyReady(row, voiceFloor));
}

/** Apply the same DM visibility contract to every platform's Speedrun cards. */
export function visibleSpeedrunDrafts(
  drafts: SpeedrunDraft[],
  showDms: boolean,
): SpeedrunDraft[] {
  if (showDms) return drafts;
  return drafts
    .filter((draft) => draft.kind !== "dm")
    .map((draft) =>
      draft.dmText || draft.dmApprovalId
        ? { ...draft, dmText: null, dmApprovalId: null }
        : draft,
    );
}

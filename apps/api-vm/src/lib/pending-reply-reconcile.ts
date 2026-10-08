import { readXSourceTimestamp } from "@noelle/x-client";
import { PENDING_REPLY_PAGE_SIZE, type PendingReplyCursor } from "./pending-reply-pagination.js";

type JsonObject = Record<string, unknown>;

export type PendingReplySkipReason =
  | "automatic-review-human-required"
  | "automatic-review-missing"
  | "automatic-review-failed"
  | "automatic-review-invalid-judge"
  | "automatic-review-low-voice"
  | "automatic-review-expired"
  | "automatic-review-sibling";

export interface PendingReplyBacklogCandidate {
  approvalId: string;
  approvalCreatedAt: string;
  draftId: string;
  leadId: string;
  leadExternalId: string | null;
  orgId: string;
  agentInstanceId: string;
  platform: "linkedin" | "x";
  draftPayload: JsonObject;
  leadPayload: JsonObject;
}

export interface PendingReplyBacklogPolicy {
  linkedinVoiceFloor: number;
  xMaxAgeHours: number;
  notificationMaxAgeHours: number;
  now: Date;
}

export type PendingReplyBacklogCursor = PendingReplyCursor;

export interface PendingReplyReconcileStore {
  list(orgId: string, after?: PendingReplyBacklogCursor, through?: Date): Promise<PendingReplyBacklogCandidate[]>;
  skip(
    candidate: PendingReplyBacklogCandidate,
    reason: PendingReplySkipReason,
    decidedAt: string,
  ): Promise<boolean>;
}

export interface PendingReplyReconcileCounts {
  selected: number;
  kept: number;
  planned: number;
  skipped: number;
  stale: number;
  byReason: Partial<Record<PendingReplySkipReason, number>>;
}

function object(value: unknown): JsonObject | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Null means this row still satisfies the automatic actor review policy. */
export function pendingReplySkipReason(
  candidate: PendingReplyBacklogCandidate,
  policy: PendingReplyBacklogPolicy,
): PendingReplySkipReason | null {
  const draft = candidate.draftPayload;
  const kind = draft.kind ?? "reply";
  if (kind !== "reply") return null;
  if (draft.human_review_required === true && draft.human_send_approved !== true) {
    return "automatic-review-human-required";
  }

  const review = object(draft.verifier_meta);
  if (!review) return "automatic-review-missing";
  if (review.pass === false) return "automatic-review-failed";
  if (review.pass !== true || review.judgeOk !== true) return "automatic-review-invalid-judge";

  if (candidate.platform === "linkedin") {
    const voice = object(review.scores)?.voice;
    if (typeof voice !== "number" || !Number.isFinite(voice) || voice < policy.linkedinVoiceFloor) {
      return "automatic-review-low-voice";
    }
    return null;
  }

  if (policy.xMaxAgeHours <= 0) return null;
  const source = candidate.leadPayload.source;
  const classifier = object(candidate.leadPayload.classifier);
  if (source === "extension_observed" && classifier?.judge === "jev") return null;
  const postedAt = readXSourceTimestamp(candidate.leadPayload.posted_at);
  const postedMs = postedAt ? Date.parse(postedAt) : Number.NaN;
  if (!Number.isFinite(postedMs)) return null;
  const maxAgeHours = source === "notification"
    ? policy.notificationMaxAgeHours
    : policy.xMaxAgeHours;
  return policy.now.getTime() - postedMs > maxAgeHours * 3_600_000
    ? "automatic-review-expired"
    : null;
}

function targetKey(candidate: PendingReplyBacklogCandidate): string | null {
  const externalId = nonempty(candidate.leadExternalId);
  if (externalId) return `${candidate.platform}:id:${externalId}`;
  const payload = candidate.leadPayload;
  const url = nonempty(payload.postUrl)
    ?? nonempty(payload.original_post_url)
    ?? nonempty(payload.url);
  return url ? `${candidate.platform}:url:${url}` : null;
}

/**
 * Plans in oldest-approval order so one deterministic reply survives per lead
 * and target. Applying is idempotent because the store updates pending rows only.
 */
export async function reconcilePendingReplyBacklog(args: {
  orgId: string;
  store: PendingReplyReconcileStore;
  policy: PendingReplyBacklogPolicy;
  apply: boolean;
}): Promise<PendingReplyReconcileCounts> {
  const counts: PendingReplyReconcileCounts = {
    selected: 0,
    kept: 0,
    planned: 0,
    skipped: 0,
    stale: 0,
    byReason: {},
  };
  const keptLeads = new Set<string>();
  const keptTargets = new Set<string>();
  const decidedAt = args.policy.now.toISOString();
  let after: PendingReplyBacklogCursor | undefined;
  while (true) {
    const rows = (await args.store.list(args.orgId, after, args.policy.now))
      .filter((row) => row.orgId === args.orgId)
      .sort((a, b) => a.approvalCreatedAt.localeCompare(b.approvalCreatedAt)
        || a.approvalId.localeCompare(b.approvalId));
    if (!rows.length) break;
    for (const row of rows) {
      counts.selected++;
      let reason = pendingReplySkipReason(row, args.policy);
      if (!reason && (row.draftPayload.kind ?? "reply") === "reply") {
        const target = targetKey(row);
        if (keptLeads.has(row.leadId) || (target != null && keptTargets.has(target))) {
          reason = "automatic-review-sibling";
        } else {
          keptLeads.add(row.leadId);
          if (target) keptTargets.add(target);
        }
      }
      if (!reason) {
        counts.kept++;
        continue;
      }
      counts.planned++;
      counts.byReason[reason] = (counts.byReason[reason] ?? 0) + 1;
      if (!args.apply) continue;
      if (await args.store.skip(row, reason, decidedAt)) counts.skipped++;
      else counts.stale++;
    }
    const last = rows[rows.length - 1]!;
    if (after && last.approvalCreatedAt === after.approvalCreatedAt && last.approvalId === after.approvalId) {
      throw new Error("Reply reconciliation cursor did not advance");
    }
    after = { approvalCreatedAt: last.approvalCreatedAt, approvalId: last.approvalId };
    if (rows.length < PENDING_REPLY_PAGE_SIZE) break;
  }
  return counts;
}

import type { Sql } from "postgres";
import { listVideoGenerationHolds } from "@noelle/runtime/video-generation-holds-db";
import type { HeldBriefClaim } from "@noelle/runtime/video-recording-brief-db";
export { claimReadyDraftsForBrief, insertRecordingBrief, revertBriefClaim, markBriefClaimOutcome, markBriefDispatched,
  type ClaimedDraftForBrief, type BriefFailureReason, type HeldBriefClaim, type InsertRecordingBriefArgs } from "@noelle/runtime/video-recording-brief-db";

/** Worker status uses the same coherent bounded hold page as operator recovery. */
export async function listHeldBriefClaims(sql: Sql, instanceId: string, orgId: string): Promise<HeldBriefClaim[]> {
  const page = await listVideoGenerationHolds(sql, { instanceId, orgId, kind: "recording_brief", limit: 8 });
  return page.holds.map(row => ({ id: row.id, status: row.status, reason: row.reason as HeldBriefClaim["reason"] }));
}

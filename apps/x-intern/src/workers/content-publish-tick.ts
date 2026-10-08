import type { Sql } from "postgres";
import {
  type XWriteClient,
  XLockError,
  XChallengeError,
  XRateLimitError,
  XDuplicateError,
  isDefiniteXWriteRejection,
  XWriteUncertainError,
} from "@noelle/x-client";
import { xApiActionRow } from "@noelle/runtime";
import { readContentMedia } from "@noelle/runtime/content-media-read";
import {
  reserveXApiWrite,
  releaseXApiWrite,
  type XApiWriteReservation,
} from "../lib/x-api-budget.js";
import {
  CONTENT_PUBLISH_UNCERTAIN_ERROR,
  CONTENT_PUBLISH_DUPLICATE_ERROR,
  claimContentPublish,
  loadContentPublishDraftText,
  loadContentPublishMedia,
  restoreContentPublishClaim,
  withContentPublishAuthorization,
  type ContentPublishMedia,
  type ContentPublishScope,
} from "../lib/content-publish-db.js";

export type PublishStatus =
  | "published"
  | "duplicate"
  | "rate_limited"
  | "locked"
  | "challenged"
  | "failed"
  | "cap_reached"
  | "no_client"
  | "no_text"
  | "cancelled"
  | "uncertain";

export interface PublishOutcome {
  slotId: string;
  status: PublishStatus;
  receipt?: { id: string; url: string };
  reconciliationPersisted?: boolean;
  failurePhase?: "draft_load" | "budget_reservation" | "authorization";
  claimRetained?: boolean;
  budgetReservationUncertain?: boolean;
}

/**
 * Publish AT MOST ONE due, ready, auto-publish slot for one Vega instance via the
 * official X API. The slot: claim → load the bound draft's text → reserve the
 * daily cap → post (top-level, links stripped in the client) → write posted_url.
 * Errors are slot-keyed + idempotent: a duplicate requires reconciliation; lock/
 * challenge/rate-limit return the slot to 'ready' and STOP the tick (the entry
 * flips send_enabled on a lock). Ambiguous writes and persistence failures after
 * a receipt require reconciliation; they retain the reservation and cannot retry.
 *
 * Anti-burst: the tick publishes a single slot and refuses to publish again until
 * `minSpacingMs` has elapsed since the last post. A backlog of overdue slots (the
 * worker was down, several times passed) therefore drains ONE post per spacing
 * window instead of firing the whole backlog in one tick. The drain rate is set by the spacing,
 * independent of the poll cadence.
 */
export async function runContentPublishTick(args: {
  sql: Sql;
  instanceId: string;
  orgId: string;
  cap: number;
  minSpacingMs: number;
  client: XWriteClient | null;
  /** Local media dir (self-host `local` backend). Null ⇒ fetch content_media.url
   *  (the `gcs` backend, or any absolute URL). */
  mediaDir?: string | null;
  resolveMediaUrls?: (ids: string[]) => Promise<Array<{ id: string; url: string | null }>>;
}): Promise<PublishOutcome[]> {
  const { sql, instanceId, orgId, cap, minSpacingMs } = args;
  const mediaDir = args.mediaDir ?? null;
  const scope: ContentPublishScope = { orgId, instanceId, minSpacingMs };
  const claim = await claimContentPublish(sql, scope);
  if (!claim) return [];
  const claimed = [claim];

  // No connected X account → return the slots to 'ready'. A post NEVER routes
  // through bird (it can only reply); it waits for the official client.
  if (!args.client) {
    await restoreContentPublishClaim(sql, scope, claim);
    return claimed.map((c) => ({ slotId: c.id, status: "no_client" as const }));
  }
  const client = args.client;

  const outcomes: PublishOutcome[] = [];
  for (const slot of claimed) {
    let text: string | null;
    let reservation: XApiWriteReservation | null = null;
    let refundAttempted = false;
    const refundOnce = async () => {
      if (!reservation || refundAttempted) return;
      refundAttempted = true;
      await releaseXApiWrite(sql, reservation);
    };
    let failurePhase: NonNullable<PublishOutcome["failurePhase"]> = "draft_load";
    try {
      text = await loadContentPublishDraftText(sql, scope, slot);
      if (!text) {
        await sql`update noelle.content_schedule_slots set status='failed', error_message='no draft body'
          where id=${slot.id} and org_id=${orgId} and agent_instance_id=${instanceId}
            and draft_id=${slot.draft_id} and idea_id=${slot.idea_id} and status='publishing'`;
        outcomes.push({ slotId: slot.id, status: "no_text" });
        continue;
      }
      failurePhase = "budget_reservation";
      reservation = await reserveXApiWrite(sql, { agentInstanceId: instanceId, orgId, cap });
      if (!reservation) {
        await restoreContentPublishClaim(sql, scope, slot);
        outcomes.push({ slotId: slot.id, status: "cap_reached" });
        break; // daily cap hit — stop this tick
      }
    } catch {
      // No X post was dispatched. A lost reservation response may still have
      // consumed budget, so retain it rather than decrementing an unknown result.
      const budgetReservationUncertain = failurePhase === "budget_reservation";
      const restored = await restoreContentPublishClaim(
        sql,
        scope,
        slot,
        budgetReservationUncertain
          ? "pre-dispatch budget reservation failed; reservation may be retained"
          : "pre-dispatch draft load failed",
      ).catch(() => false);
      outcomes.push({
        slotId: slot.id,
        status: "failed",
        failurePhase,
        claimRetained: !restored,
        budgetReservationUncertain,
      });
      break;
    }

    const startedAt = new Date();
    let postDispatched = false;
    let receipt: PublishOutcome["receipt"];
    try {
      // Upload any image(s) the operator attached to this post and attach them.
      // A retryable X error here (rate-limit / lock) propagates to the catch and
      // returns the slot to 'ready' exactly like a failed post; an unreadable
      // asset is skipped so a missing file never hard-blocks the post.
      const media = await prepareSlotMedia(sql, client, slot.draft_id, mediaDir, scope, args.resolveMediaUrls);
      const result = await withContentPublishAuthorization(
        sql,
        scope,
        slot,
        media.descriptors,
        async (tx, currentText) => {
          postDispatched = true;
          const res = await client.postTweet({
            text: currentText,
            ...(media.ids.length > 0 ? { mediaIds: media.ids } : {}),
          });
          receipt = res;
          const persisted = await tx<Array<{ id: string }>>`
        update noelle.content_schedule_slots
           set status='published', posted_url=${res.url}, posted_tweet_id=${res.id ?? null},
               published_at=clock_timestamp()
         where id=${slot.id} and agent_instance_id=${instanceId} and org_id=${orgId}
           and draft_id=${slot.draft_id} and idea_id=${slot.idea_id}
           and status='publishing' and posted_url is null
        returning id
      `;
          if (persisted.length !== 1) throw new Error("publish receipt was not persisted");
          return res;
        },
      );
      if (!result) {
        await refundOnce();
        const restorationCompleted = await restoreContentPublishClaim(sql, scope, slot).then(
          () => true,
          () => false,
        );
        outcomes.push({
          slotId: slot.id,
          status: "cancelled",
          ...(!restorationCompleted
            ? { failurePhase: "authorization" as const, claimRetained: true }
            : {}),
        });
        break;
      }
      await recordXApiSpend(sql, orgId, instanceId, startedAt);
      outcomes.push({ slotId: slot.id, status: "published" });
    } catch (err) {
      const knownRejected = isDefiniteXWriteRejection(err);
      if (receipt || (postDispatched && (err instanceof XWriteUncertainError || !knownRejected))) {
        receipt ??= err instanceof XWriteUncertainError ? err.receipt : undefined;
        // Preserve the external receipt even if this second DB write also fails.
        // The original publishing claim remains outside the ready-only selector.
        const reconciliationPersisted = await sql`
          update noelle.content_schedule_slots
             set status='failed', posted_url=coalesce(${receipt?.url ?? null}, posted_url),
                 posted_tweet_id=coalesce(${receipt?.id ?? null}, posted_tweet_id),
                 published_at=case when ${receipt?.id ?? null}::text is not null then coalesce(published_at, now()) else published_at end,
                 error_message=${CONTENT_PUBLISH_UNCERTAIN_ERROR}, updated_at=now()
           where id=${slot.id} and agent_instance_id=${instanceId} and org_id=${orgId}
             and draft_id=${slot.draft_id} and idea_id=${slot.idea_id}
          returning id
        `.then(
          (rows) => rows.length > 0,
          () => false,
        );
        outcomes.push({
          slotId: slot.id,
          status: "uncertain",
          ...(receipt ? { receipt } : {}),
          reconciliationPersisted,
        });
        break;
      }
      if (err instanceof XDuplicateError) {
        // X rejected this attempt, but does not identify the existing post.
        // Release its budget and hold the slot until a receipt is reconciled.
        await refundOnce();
        const reconciliationPersisted = await sql`
          update noelle.content_schedule_slots
             set status='failed', error_message=${CONTENT_PUBLISH_DUPLICATE_ERROR}, updated_at=now()
           where id=${slot.id} and agent_instance_id=${instanceId} and org_id=${orgId}
             and draft_id=${slot.draft_id} and idea_id=${slot.idea_id}
          returning id
        `.then(
          (rows) => rows.length > 0,
          () => false,
        );
        outcomes.push({ slotId: slot.id, status: "duplicate", reconciliationPersisted });
        break;
      }
      // Definitively-not-sent → release the reservation + return the slot.
      await refundOnce();
      await restoreContentPublishClaim(sql, scope, slot);
      if (err instanceof XLockError) {
        outcomes.push({ slotId: slot.id, status: "locked" });
        break;
      }
      if (err instanceof XChallengeError) {
        outcomes.push({ slotId: slot.id, status: "challenged" });
        break;
      }
      if (err instanceof XRateLimitError) {
        outcomes.push({ slotId: slot.id, status: "rate_limited" });
        break;
      }
      const msg = err instanceof Error ? err.message : String(err);
      await sql`update noelle.content_schedule_slots set error_message=${msg}
        where id=${slot.id} and org_id=${orgId} and agent_instance_id=${instanceId}
          and draft_id=${slot.draft_id} and idea_id=${slot.idea_id}`;
      outcomes.push({ slotId: slot.id, status: "failed" });
    }
  }
  return outcomes;
}

/** Resolve → read → upload the slot's image(s); returns the X media ids to attach. */
export async function uploadSlotMedia(
  sql: Sql,
  client: XWriteClient,
  draftId: string | null,
  mediaDir: string | null,
  scope: Pick<ContentPublishScope, "orgId" | "instanceId">,
  resolveUrls?: (ids: string[]) => Promise<Array<{ id: string; url: string | null }>>,
): Promise<string[]> {
  return (await prepareSlotMedia(sql, client, draftId, mediaDir, scope, resolveUrls)).ids;
}

/** Upload outside the authorization transaction and retain its source snapshot. */
async function prepareSlotMedia(
  sql: Sql,
  client: XWriteClient,
  draftId: string | null,
  mediaDir: string | null,
  scope: Pick<ContentPublishScope, "orgId" | "instanceId">,
  resolveUrls?: (ids: string[]) => Promise<Array<{ id: string; url: string | null }>>,
): Promise<{ ids: string[]; descriptors: ContentPublishMedia[] }> {
  if (!draftId) return { ids: [], descriptors: [] };
  const descriptors = await loadContentPublishMedia(sql, scope, draftId);
  const urls = resolveUrls && descriptors.length
    ? new Map((await resolveUrls(descriptors.map(row => row.id))).map(row => [row.id.toLowerCase(), row.url])) : null;
  const ids: string[] = [];
  for (const d of descriptors) {
    const bytes = await readContentMedia(mediaDir, urls ? { ...d, url: urls.get(d.id.toLowerCase()) ?? null } : d);
    if (!bytes) continue; // unreadable asset — don't block the post
    const { mediaId } = await client.uploadMedia({
      bytes,
      mimeType: d.mime_type ?? "application/octet-stream",
    });
    if (mediaId) ids.push(mediaId);
  }
  return { ids, descriptors };
}

async function recordXApiSpend(
  sql: Sql,
  orgId: string,
  instanceId: string,
  startedAt: Date,
): Promise<void> {
  const row = xApiActionRow({
    orgId,
    instanceId,
    worker: "content-publish",
    kind: "post",
    startedAt,
  });
  await sql`
    insert into noelle.llm_calls
      (org_id, agent_instance_id, agent_role, worker, engine, model, bucket,
       input_tokens, output_tokens, cents, latency_ms, status, started_at)
    values
      (${row.orgId}, ${row.instanceId}, ${row.agentRole}, ${row.worker}, ${row.engine},
       ${row.model}, ${row.bucket}, ${row.inputTokens}, ${row.outputTokens}, ${row.cents},
       ${row.latencyMs}, ${row.status}, ${row.startedAt})
  `.catch(() => {
    /* spend metering is best-effort, never blocks a publish */
  });
}

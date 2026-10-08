import type { Sql, TransactionSql } from "postgres";
import { matchesRedditClaim, recordRedditClaimSent, redditReplyClaimSql } from "./reddit-browser-reply-claims-db.js";
import { readXSourceId } from "@noelle/x-client";

type UndoResult =
  | { ok: true; approval_id: string; draft_id: string; status: "pending"; restored: number }
  | { ok: false; error: "not_found" | "not_undoable" | "cannot_undo_real_send"; status: 404 | 409; detail?: string };

type LockedRecord = {
  id: string; draft_id: string; lead_id: string | null; status: string; decided_at: Date | null;
  receipt: string | null; sent_at: Date | null; posted_at: Date | null; stored_sent_via: string | null;
  stored_sent_url: string | null; claimed: boolean; reddit_claimed: boolean; platform: string | null;
};

async function lockManualRecord(tx: TransactionSql, approvalId: string, orgId: string): Promise<LockedRecord | null> {
  await tx`set local lock_timeout = '5s'`;
  await tx`set local statement_timeout = '10s'`;
  // Reddit dispatch locks the current parent before draft/approval receipt rows.
  await tx`select ai.id from noelle.agent_instances ai join noelle.approvals a on a.agent_instance_id=ai.id
    where a.id=${approvalId} and a.org_id=${orgId} and ai.org_id=a.org_id
      and (ai.role='reddit_intern' or ${redditReplyClaimSql(tx)}) for no key update of ai`;
  // Receipt writers update the draft before the approval.
  const [draft] = await tx<{ id: string }[]>`
    select d.id from noelle.drafts d join noelle.approvals a on a.draft_id=d.id and a.org_id=d.org_id
    where a.id=${approvalId} and a.org_id=${orgId} for update of d
  `;
  if (!draft) return null;
  const [row] = await tx<LockedRecord[]>`
    select a.id,a.draft_id,a.lead_id,a.status,a.decided_at,d.sent_external_id as receipt,d.sent_at,d.posted_at,
      d.payload->>'sent_via' as stored_sent_via,d.payload->>'sent_url' as stored_sent_url,
      (exists(select 1 from noelle.x_reply_claims claim where claim.org_id=a.org_id and claim.approval_id=a.id)
       or exists(select 1 from noelle.linkedin_reply_claims claim where claim.org_id=a.org_id and claim.approval_id=a.id)
       or ${redditReplyClaimSql(tx)}) as claimed,
      ${redditReplyClaimSql(tx)} as reddit_claimed,
      l.platform
    from noelle.approvals a join noelle.drafts d on d.id=a.draft_id and d.org_id=a.org_id
    left join noelle.leads l on l.id=a.lead_id
    where a.id=${approvalId} and a.org_id=${orgId} and a.draft_id=${draft.id} for update of a
  `;
  if (row?.reddit_claimed && row.lead_id)
    await tx`select id from noelle.leads where id=${row.lead_id} and org_id=${orgId} for no key update`;
  return row ?? null;
}

export type MarkApprovalSentResult = {
  approval_id: string; draft_id: string; status: "sent"; sent_at: string;
  sent_via: "manual" | "extension"; sent_url: string | null; sibling_skipped: number;
};

function receiptIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/.test(url.hostname)) return null;
    return readXSourceId(url.pathname.match(/^\/(?:[a-zA-Z0-9_]{1,15}|i\/web)\/status\/([0-9]{1,25})(?:\/(?:photo|video)\/[0-9]+)?\/?$/)?.[1]);
  } catch { return null; }
}

/** Record the operator/browser's completed send without dispatching a platform write. */
export async function markApprovalSent(sql: Sql, opts: {
  approvalId: string; orgId: string; decidedBy: string; sentVia: "manual" | "extension"; tweetUrl?: string | null;
}): Promise<{ ok: true; result: MarkApprovalSentResult } | { ok: false; error: string; detail?: string; status: 400 | 404 | 409 | 500 }> {
  const tweetId = opts.tweetUrl ? receiptIdFromUrl(opts.tweetUrl) : null;
  if (opts.tweetUrl && !tweetId) return { ok: false, error: "invalid_tweet_url", status: 400 };
  try {
    return await sql.begin(async (tx) => {
      const row = await lockManualRecord(tx, opts.approvalId, opts.orgId);
      if (!row) return { ok: false, error: "not_found", status: 404 };
      if (row.reddit_claimed && !await matchesRedditClaim(tx, opts.orgId, opts.approvalId))
        return { ok: false, error: "reddit_claim_changed", status: 409 };
      if (row.status === "sent") {
        const stamp = row.decided_at ?? row.sent_at ?? row.posted_at;
        if (!row.receipt || !stamp) return { ok: false, error: "send_unconfirmed", status: 409 };
        if (!row.receipt.startsWith("manual:") && row.stored_sent_via !== "manual" && row.stored_sent_via !== "extension")
          return { ok: false, error: "already_sent", status: 409 };
        return { ok: true, result: { approval_id: row.id, draft_id: row.draft_id, status: "sent",
          sent_at: new Date(stamp).toISOString(), sent_via: row.stored_sent_via === "extension" ? "extension" : "manual",
          sent_url: row.stored_sent_url, sibling_skipped: 0 } };
      }
      if (!["pending", "deferred", "errored"].includes(row.status))
        return { ok: false, error: "already_actioned", detail: row.status, status: 409 };
      if (row.reddit_claimed && opts.sentVia !== "extension")
        return { ok: false, error: "send_already_claimed", status: 409 };
      if (row.platform === "reddit" && opts.sentVia === "extension" && !row.reddit_claimed)
        return { ok: false, error: "reddit_claim_required", status: 409 };
      if (row.receipt || row.sent_at || (row.claimed && opts.sentVia !== "extension" && !tweetId))
        return { ok: false, error: "send_already_claimed", status: 409 };
      const [clock] = await tx<{ at: Date }[]>`select now() as at`;
      const stamp = clock!.at;
      await tx`
        update noelle.drafts set sent_external_id=coalesce(${tweetId},'manual:'||id::text),posted_at=${stamp},
          payload=coalesce(payload,'{}'::jsonb)||${tx.json({ sent_via: opts.sentVia, ...(tweetId ? { sent_url: opts.tweetUrl } : {}) })}
        where id=${row.draft_id} and org_id=${opts.orgId} and sent_external_id is null
      `;
      await tx`update noelle.approvals set status='sent',decided_at=${stamp},decided_by=${opts.decidedBy}
        where id=${row.id} and org_id=${opts.orgId}`;
      if (row.reddit_claimed) await recordRedditClaimSent(tx, opts.orgId, opts.approvalId);
      const siblings = row.lead_id ? await tx<{ id: string }[]>`
        update noelle.approvals a set status='skipped',decided_at=${stamp},decided_by=${opts.decidedBy},skip_reason='sibling-angle-sent'
        from noelle.drafts d where d.id=a.draft_id and d.org_id=a.org_id and a.org_id=${opts.orgId}
          and a.lead_id=${row.lead_id} and a.id<>${row.id} and a.status='pending' and coalesce(d.payload->>'kind','reply')<>'dm'
          and not ${redditReplyClaimSql(tx)}
        returning a.id
      ` : [];
      if (row.lead_id) await tx`
        update noelle.approvals a set status='deferred',decided_at=${stamp},decided_by=${opts.decidedBy}
        from noelle.drafts d,noelle.agent_instances ai
        where d.id=a.draft_id and d.org_id=a.org_id and ai.id=a.agent_instance_id and ai.org_id=a.org_id
          and a.org_id=${opts.orgId} and a.lead_id=${row.lead_id} and a.status='pending'
          and coalesce(d.payload->>'kind','reply')='dm' and ai.auto_defer_dms=true
      `;
      return { ok: true, result: { approval_id: row.id, draft_id: row.draft_id, status: "sent",
        sent_at: stamp.toISOString(), sent_via: opts.sentVia, sent_url: tweetId ? opts.tweetUrl! : null, sibling_skipped: siblings.length } };
    });
  } catch (err) {
    return { ok: false, error: "internal", detail: err instanceof Error ? err.message : String(err), status: 500 };
  }
}

/** Undo only a manual record, rechecking receipts after acquiring row locks. */
export async function undoManualSent(sql: Sql, args: { approvalId: string; orgId: string }): Promise<UndoResult> {
  return sql.begin(async (tx) => {
    const row = await lockManualRecord(tx, args.approvalId, args.orgId);
    if (!row) return { ok: false, error: "not_found", status: 404 };
    if (row.sent_at || row.claimed || (row.receipt != null && !row.receipt.startsWith("manual:")))
      return { ok: false, error: "cannot_undo_real_send", status: 409, detail: "draft has a platform receipt or an outstanding write claim" };
    if (row.status === "pending")
      return { ok: true, approval_id: row.id, draft_id: row.draft_id, status: "pending", restored: 0 };
    if (row.status !== "sent" || !row.receipt?.startsWith("manual:"))
      return { ok: false, error: "not_undoable", status: 409, detail: row.status };
    await tx`
      update noelle.drafts set sent_external_id=null,posted_at=null,
        payload=coalesce(payload,'{}'::jsonb)-'sent_via'-'sent_url'
      where id=${row.draft_id} and org_id=${args.orgId}
    `;
    await tx`
      update noelle.approvals set status='pending',decided_at=null,decided_by=null
      where id=${row.id} and org_id=${args.orgId}
    `;
    const restored = row.lead_id && row.decided_at ? await tx<{ id: string }[]>`
      update noelle.approvals set status='pending',decided_at=null,decided_by=null,skip_reason=null
      where org_id=${args.orgId} and lead_id=${row.lead_id} and id<>${row.id}
        and decided_at=${row.decided_at}
        and ((status='skipped' and skip_reason='sibling-angle-sent') or status='deferred')
      returning id
    ` : [];
    return { ok: true, approval_id: row.id, draft_id: row.draft_id, status: "pending", restored: restored.length };
  });
}

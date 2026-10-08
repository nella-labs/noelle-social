import type { Sql } from "postgres";

import { CONTENT_PUBLISH_UNCERTAIN_ERROR, CONTENT_PUBLISH_DUPLICATE_ERROR } from "@noelle/contracts";
export { CONTENT_PUBLISH_UNCERTAIN_ERROR, CONTENT_PUBLISH_DUPLICATE_ERROR } from "@noelle/contracts";

export interface ContentPublishScope {
  orgId: string;
  instanceId: string;
  minSpacingMs: number;
}
export interface ContentPublishClaim {
  id: string;
  draft_id: string;
  idea_id: string;
}
export interface ContentPublishMedia {
  id: string;
  storage_key: string;
  url: string | null;
  mime_type: string | null;
  fingerprint: string;
}

async function lockInstance(
  sql: Sql,
  scope: ContentPublishScope,
  skipLocked: boolean,
): Promise<boolean> {
  const [instance] = await sql<
    { role: string; status: string; send_enabled: boolean; x_api_write_enabled: boolean }[]
  >`
    select role,status,send_enabled,x_api_write_enabled from noelle.agent_instances
    where id=${scope.instanceId} and org_id=${scope.orgId}
    for no key update ${skipLocked ? sql`skip locked` : sql``}
  `;
  return (
    !!instance &&
    instance.role === "x_intern" &&
    ["active", "paused"].includes(instance.status) &&
    instance.send_enabled === true &&
    instance.x_api_write_enabled === true
  );
}

async function hasPublishBarrier(
  sql: Sql,
  scope: ContentPublishScope,
  ownSlotId: string | null,
): Promise<boolean> {
  const rows = await sql`select id from noelle.content_schedule_slots
    where org_id=${scope.orgId} and agent_instance_id=${scope.instanceId} and platform='x'
      and id is distinct from ${ownSlotId}::uuid
      and (status='publishing'
        or error_message in (${CONTENT_PUBLISH_UNCERTAIN_ERROR}, ${CONTENT_PUBLISH_DUPLICATE_ERROR})
        or (${scope.minSpacingMs > 0} and published_at > clock_timestamp() - make_interval(secs => ${scope.minSpacingMs / 1000})))
    limit 1`;
  return rows.length > 0;
}

/** Locks parents before their soft-bound slot, matching content admission order. */
async function lockBinding(
  sql: Sql,
  scope: ContentPublishScope,
  claim: ContentPublishClaim,
  status: "ready" | "publishing",
) {
  const [idea] = await sql`select id from noelle.post_ideas
    where id=${claim.idea_id} and org_id=${scope.orgId} and agent_instance_id=${scope.instanceId}
      and status not in ('published','dismissed') for no key update`;
  if (!idea) return null;
  const [draft] = await sql<
    { body: string; final_body: string | null }[]
  >`select body,final_body from noelle.post_drafts
    where id=${claim.draft_id} and org_id=${scope.orgId} and agent_instance_id=${scope.instanceId}
      and idea_id=${claim.idea_id} and platform='x' and status not in ('published','dismissed')
      and posted_url is null for no key update`;
  if (!draft) return null;
  const [slot] = await sql`select id from noelle.content_schedule_slots
    where id=${claim.id} and org_id=${scope.orgId} and agent_instance_id=${scope.instanceId}
      and draft_id=${claim.draft_id} and (idea_id=${claim.idea_id} or (${status === "ready"} and idea_id is null)) and platform='x'
      and status=${status} and auto_publish=true and slot_at<=clock_timestamp()
      and posted_url is null and posted_tweet_id is null and published_at is null for no key update`;
  return slot ? draft : null;
}

async function setTransactionBounds(sql: Sql): Promise<void> {
  await sql`set local lock_timeout='5s'`;
  await sql`set local statement_timeout='10s'`;
  // OAuth refresh and a reactive retry can each add a bounded 20s request.
  await sql`set local idle_in_transaction_session_timeout='120s'`;
}

/** A committed publishing claim survives a later write/receipt transaction failure. */
export async function claimContentPublish(
  sql: Sql,
  scope: ContentPublishScope,
): Promise<ContentPublishClaim | null> {
  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    await setTransactionBounds(tx);
    // Busy publishers are skipped rather than occupying the connection pool
    // needed by the active publisher's token refresh coordinator.
    if (!(await lockInstance(tx, scope, true)) || (await hasPublishBarrier(tx, scope, null)))
      return null;
    const [candidate] = await tx<ContentPublishClaim[]>`select s.id,s.draft_id,d.idea_id
      from noelle.content_schedule_slots s
      join noelle.post_drafts d on d.id=s.draft_id and (d.idea_id=s.idea_id or s.idea_id is null)
        and d.org_id=s.org_id and d.agent_instance_id=s.agent_instance_id and d.platform='x'
        and d.status not in ('published','dismissed') and d.posted_url is null
      join noelle.post_ideas i on i.id=d.idea_id and i.org_id=s.org_id and i.agent_instance_id=s.agent_instance_id
        and i.status not in ('published','dismissed')
      where s.org_id=${scope.orgId} and s.agent_instance_id=${scope.instanceId} and s.platform='x'
        and s.status='ready' and s.auto_publish=true and s.slot_at<=clock_timestamp()
        and s.posted_url is null and s.posted_tweet_id is null and s.published_at is null
      order by s.slot_at,s.id limit 1`;
    if (!candidate || !(await lockBinding(tx, scope, candidate, "ready"))) return null;
    await tx`update noelle.content_schedule_slots set status = 'publishing',idea_id=${candidate.idea_id},updated_at=now()
      where id=${candidate.id} and org_id=${scope.orgId} and agent_instance_id=${scope.instanceId}`;
    return candidate;
  }) as Promise<ContentPublishClaim | null>;
}

/** Final authorization stays locked through dispatch and receipt persistence. */
export async function withContentPublishAuthorization<T>(
  sql: Sql,
  scope: ContentPublishScope,
  claim: ContentPublishClaim,
  preparedMedia: ContentPublishMedia[],
  dispatch: (tx: Sql, text: string) => Promise<T>,
): Promise<T | null> {
  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    await setTransactionBounds(tx);
    if (!(await lockInstance(tx, scope, false)) || (await hasPublishBarrier(tx, scope, claim.id)))
      return null;
    const draft = await lockBinding(tx, scope, claim, "publishing");
    const text = (draft?.final_body ?? draft?.body ?? "").trim();
    if (!text) return null;
    const currentMedia = await loadContentPublishMedia(tx, scope, claim.draft_id, true);
    if (
      currentMedia.length !== preparedMedia.length ||
      currentMedia.some(
        (row, i) =>
          row.id !== preparedMedia[i]?.id || row.fingerprint !== preparedMedia[i]?.fingerprint,
      )
    )
      return null;
    return dispatch(tx, text);
  }) as Promise<T | null>;
}

/** One canonical bounded selection serves preparation and locked final authorization. */
export async function loadContentPublishMedia(
  sql: Sql,
  scope: Pick<ContentPublishScope, "orgId" | "instanceId">,
  draftId: string,
  lock = false,
): Promise<ContentPublishMedia[]> {
  return sql<
    ContentPublishMedia[]
  >`select m.id,m.storage_key,m.url,m.mime_type,to_jsonb(m)::text as fingerprint
    from noelle.content_media m
    join noelle.post_drafts d on d.id=${draftId} and d.org_id=${scope.orgId}
      and d.agent_instance_id=${scope.instanceId} and d.platform='x'
    join noelle.post_ideas i on i.id=d.idea_id and i.org_id=d.org_id and i.agent_instance_id=d.agent_instance_id
    where m.org_id=${scope.orgId} and (m.agent_instance_id is null or m.agent_instance_id=${scope.instanceId})
      and m.status='ready' and (m.platform is null or m.platform='x')
      and (m.kind='image' or m.mime_type like 'image/%')
      and (m.draft_id=${draftId} or m.idea_id=d.idea_id)
    order by m.created_at,m.id limit 4 ${lock ? sql`for no key update of m` : sql``}`;
}

export async function loadContentPublishDraftText(
  sql: Sql,
  scope: ContentPublishScope,
  claim: ContentPublishClaim,
): Promise<string | null> {
  const [draft] = await sql<
    { body: string; final_body: string | null }[]
  >`select body, final_body from noelle.post_drafts
    where id=${claim.draft_id} and org_id=${scope.orgId} and agent_instance_id=${scope.instanceId}
      and idea_id=${claim.idea_id} and platform='x' and status not in ('published','dismissed') and posted_url is null`;
  const text = (draft?.final_body ?? draft?.body ?? "").trim();
  return text || null;
}

/** Restores only the original, still unpublished binding after a definite non-write. */
export async function restoreContentPublishClaim(
  sql: Sql,
  scope: ContentPublishScope,
  claim: ContentPublishClaim,
  errorMessage: string | null = null,
): Promise<boolean> {
  const rows =
    await sql`update noelle.content_schedule_slots set status='ready',error_message=${errorMessage},updated_at=now()
    where id=${claim.id} and org_id=${scope.orgId} and agent_instance_id=${scope.instanceId}
      and draft_id=${claim.draft_id} and idea_id=${claim.idea_id} and status='publishing'
      and posted_url is null and posted_tweet_id is null and published_at is null returning id`;
  return rows.length > 0;
}

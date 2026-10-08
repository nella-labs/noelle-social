import type { JSONValue, Sql } from "postgres";
import type { VipSignal } from "@noelle/contracts";
import { sourceTimestampSql, xReplyAgeCutoffSql } from "@noelle/runtime";
import { BoundedPgSession } from "@noelle/runtime/bounded-pg-session";

const classificationReleaseSessions = new WeakMap<Sql, BoundedPgSession>();

function classificationReleaseSession(parent: Sql): BoundedPgSession {
  let session = classificationReleaseSessions.get(parent);
  if (!session) {
    session = new BoundedPgSession(parent, {
      deadlineMs: 3000,
      maxPending: 32,
      idleTimeoutMs: 1000,
    });
    classificationReleaseSessions.set(parent, session);
  }
  return session;
}

/**
 * Global safety ceiling for pending watchlist replies. The real constraint is
 * one pending reply per watched person (the claim is `distinct on (author)`),
 * so the effective cap is the number of watched accounts; this just bounds it if
 * someone watchlists a very large number of people.
 */
export const WATCHLIST_PENDING_CAP = 100;

export { OBSERVED_REPLY_ACTIVE_CAP } from "./reply-opportunity.js";

export interface LeadRow {
  id: string;
  external_id: string;
  payload: Record<string, unknown>;
  author_handle: string;
  author_id: string | null;
  tier: "T1" | "T2" | "T3" | null;
  classifier_label: string | null;
  classifier_score: number | null;
  /**
   * Engagement-bait flag from the classifier (shared noelle.leads column, mig
   * 0031). A comment-farming CTA post inflates its reply count with junk, so the
   * drafter must NOT read that count as real discussion when deciding whether to
   * escalate to the smarter model. Null on rows classified before this shipped.
   */
  comment_bait?: boolean | null;
  status: string;
  /** Always-reply marker: true for watchlist-person posts. Bypasses filters. */
  priority: boolean;
}

export type ClassificationClaim = LeadRow & {
  /** Exact database text, preserving timestamp precision for release CAS. */
  classification_claimed_at: string;
};

export const CLASSIFICATION_BATCH_LIMIT = 10;

export async function upsertDiscoveredLead(
  sql: Sql,
  args: {
    orgId: string;
    agentInstanceId: string;
    platform: "x" | "linkedin" | "reddit";
    externalId: string;
    authorHandle: string;
    authorId: string | null;
    payload: Record<string, unknown>;
    postedAt: string | null;
    priority: boolean;
  },
): Promise<{ id: string; inserted: boolean }> {
  // The tweet's own created_at lives inside payload.posted_at — noelle.leads
  // has no dedicated posted_at column (only created_at / updated_at, which are
  // system clocks). The dashboard pulls payload.posted_at for "tweeted Nh ago"
  // labels.
  const payloadWithPostedAt = { ...args.payload, posted_at: args.postedAt };
  const rows = await sql<{ id: string; inserted: boolean }[]>`
    with ins as (
      insert into noelle.leads
        (org_id, agent_instance_id, external_id, platform, author_handle, author_id, payload, status, priority)
      values
        (${args.orgId}, ${args.agentInstanceId}, ${args.externalId}, ${args.platform},
         ${args.authorHandle}, ${args.authorId}, ${sql.json(payloadWithPostedAt as JSONValue)}, 'new', ${args.priority})
      -- On a re-seen tweet, UPGRADE priority false→true if the author is now a
      -- watchlist person (e.g. it was first ingested via keyword/targeting
      -- before they were watchlisted). Only false→true, never a downgrade, and
      -- only the flag — status/payload are untouched (an already-classified lead
      -- isn't reopened; the bypass applies on its next classify if still 'new').
      on conflict (org_id, platform, external_id) do update
        set priority = true
        where noelle.leads.priority = false and excluded.priority = true
      returning id, (xmax = 0) as inserted
    )
    select id, inserted from ins
    union all
    select id, false as inserted
    from noelle.leads
    where org_id = ${args.orgId}
      and platform = ${args.platform}
      and external_id = ${args.externalId}
      and not exists (select 1 from ins)
    limit 1
  `;
  return rows[0]!;
}

export async function claimLeadsForClassification(
  sql: Sql,
  args: {
    orgId: string;
    agentInstanceId: string;
    batch: number;
    /**
     * Watchlist-lane mode: claim only priority (watchlist-person) leads. Used
     * when the instance is paused — the keyword lane is off, but watched
     * accounts must still be classified. Default false = claim any 'new' lead.
     */
    priorityOnly?: boolean;
  },
): Promise<ClassificationClaim[]> {
  const rows = await sql<ClassificationClaim[]>`
    update noelle.leads
    set status = 'classifying', updated_at = now()
    where id in (
      select id from noelle.leads
      where org_id = ${args.orgId}
        and agent_instance_id = ${args.agentInstanceId}
        and status = 'new'
        ${args.priorityOnly ? sql`and priority = true` : sql``}
      order by created_at asc
      for update skip locked
      limit ${args.batch}
    )
    returning id, external_id, payload, author_handle, author_id, tier, classifier_label, classifier_score, status, priority,
              updated_at::text as classification_claimed_at
  `;
  return [...rows];
}

/** Requeue only the unchanged claims rejected before model dispatch. */
export async function releaseClassificationClaims(
  sql: Sql,
  args: { orgId: string; agentInstanceId: string; claims: readonly ClassificationClaim[] },
): Promise<number> {
  if (!args.claims.length || args.claims.length > CLASSIFICATION_BATCH_LIMIT) return 0;
  const claims = args.claims.map((claim) => ({
    id: claim.id,
    claimed_at: claim.classification_claimed_at,
  }));
  return classificationReleaseSession(sql).run((owned) =>
    owned.begin(async (tx) => {
      await tx`set local lock_timeout='1s'`;
      await tx`set local statement_timeout='2s'`;
      await tx`set local idle_in_transaction_session_timeout='3s'`;
      const rows = await tx<{ id: string }[]>`
        with owner as materialized (
          select id from noelle.agent_instances
          where id = ${args.agentInstanceId} and org_id = ${args.orgId} and role = 'x_intern'
          for no key update
        )
        update noelle.leads l set status = 'new', updated_at = now()
        from owner, jsonb_to_recordset(${tx.json(claims)}::jsonb) as c(id uuid, claimed_at text)
        where l.id = c.id and l.agent_instance_id = owner.id
          and l.org_id = ${args.orgId} and l.platform = 'x' and l.status = 'classifying'
          and l.updated_at::text = c.claimed_at
        returning l.id
      `;
      return rows.length;
    }),
  );
}

/** Stage browser observations outside the legacy new/fail-open classifier lane. */
export async function claimObservedLeadsForClassification(
  sql: Sql,
  args: { orgId: string; agentInstanceId: string; batch: number },
): Promise<LeadRow[]> {
  const rows = await sql<LeadRow[]>`
    update noelle.leads l
    set status = 'observed_classifying', updated_at = now()
    where l.id in (
      select id from noelle.leads
      where org_id = ${args.orgId} and agent_instance_id = ${args.agentInstanceId}
        and platform = 'x' and status = 'observed'
        and payload->>'source' = 'extension_observed'
      order by created_at asc
      for update skip locked
      limit ${args.batch}
    )
    returning l.id, l.external_id, l.payload, l.author_handle, l.author_id,
              l.tier, l.classifier_label, l.classifier_score, l.status, l.priority
  `;
  return [...rows];
}

/**
 * How many leads this instance has ingested TODAY, across every lane. Drives the
 * daily extract cap + the watch-lane reserve (lib/discovery-budget.ts), so the
 * high-volume keyword lane cannot burn the day's Apify budget and starve the

import { Hono } from "hono";
import { z } from "zod";
import { noelleDb } from "../lib/db.js";
import { requireActuatorToken, type ActuatorContext } from "../middleware/actuator.js";
import { chooseDiscoveryTarget, normalizeBrowserObservation, type KeywordTarget, type PendingProfileTarget, type ProfileTarget } from "./linkedin-discovery.js";
import { resolveLinkedInIdentity } from "./linkedin-identity.js";
import { isLinkedInShortUrl, resolveLinkedInShortUrl } from "./linkedin-shortlink.js";
import { discoveryReplyCapacity } from "./discovery-capacity.js";

export const linkedinDiscovery = new Hono<{ Variables: { actuator: ActuatorContext } }>();

const observationSchema = z.object({
  fingerprint: z.string().min(1).max(500).optional(),
  urn: z.string().max(150).optional(),
  url: z.string().max(1000).optional(),
  text: z.string().min(1).max(10_000),
  authorName: z.string().max(300).optional(),
  authorHeadline: z.string().max(500).optional(),
  authorHandle: z.string().max(200).optional(),
  authorId: z.string().max(200).optional(),
  postedAt: z.string().max(100).optional(),
  reactionCount: z.number().int().min(0).optional(),
  commentCount: z.number().int().min(0).optional(),
});
const batchSchema = z.object({
  instanceId: z.string().uuid(),
  items: z.array(observationSchema).min(1).max(50),
});

async function ownsInstance(instanceId: string, orgId: string): Promise<boolean> {
  const rows = await noelleDb()<Array<{ id: string }>>`
    select id from noelle.agent_instances where id = ${instanceId} and org_id = ${orgId} limit 1
  `;
  return rows.length === 1;
}

linkedinDiscovery.use("/api/actuator/discovery-capacity", requireActuatorToken);
linkedinDiscovery.get("/api/actuator/discovery-capacity", async (c) => {
  const instanceId = c.req.query("instanceId");
  if (!instanceId || !z.string().uuid().safeParse(instanceId).success) return c.json({ error: "invalid_instance_id" }, 400);
  const { orgId } = c.get("actuator");
  if (!(await ownsInstance(instanceId, orgId))) return c.json({ error: "instance_not_in_org" }, 403);
  return c.json(await discoveryReplyCapacity(noelleDb(), { orgId, instanceId, platform: "linkedin" }));
});

linkedinDiscovery.use("/api/actuator/discovery-target", requireActuatorToken);
linkedinDiscovery.get("/api/actuator/discovery-target", async (c) => {
  const instanceId = c.req.query("instanceId");
  if (!instanceId || !z.string().uuid().safeParse(instanceId).success) {
    return c.json({ error: "invalid_instance_id" }, 400);
  }
  const { orgId } = c.get("actuator");
  if (!(await ownsInstance(instanceId, orgId))) return c.json({ error: "instance_not_in_org" }, 403);
  const sql = noelleDb();
  // One call means one existing ambient navigation opportunity. The counter is
  // durable across extension restarts and supplies the every-fifth oldest slot.
  const count = await sql<Array<{ slot_count: string }>>`
    insert into noelle.linkedin_discovery_schedule (org_id, agent_instance_id, slot_count)
    values (${orgId}, ${instanceId}, 1)
    on conflict (agent_instance_id) do update
      set slot_count = noelle.linkedin_discovery_schedule.slot_count + 1,
          updated_at = now()
    returning slot_count::text
  `;
  const profiles = await sql<ProfileTarget[]>`
    select id::text, public_id as "publicId",
           last_checked_at::text as "lastCheckedAt",
           latest_observed_post_at::text as "latestObservedPostAt"
    from noelle.linkedin_watchlist_people
    where org_id = ${orgId} and agent_instance_id = ${instanceId} and public_id is not null
  `;
  const keywords = await sql<KeywordTarget[]>`
    select id::text, value, last_checked_at::text as "lastCheckedAt"
    from noelle.linkedin_watchlist
    where org_id = ${orgId} and agent_instance_id = ${instanceId} and kind = 'keyword'
  `;
  // Qualified cards can scroll away before their activity link is resolved.
  // Group by public author ID so one revisit cools every pending card by that
  // author. The timestamp lives on those lead payloads, across actor restarts.
  const pendingProfiles = await sql<PendingProfileTarget[]>`
    select lower(author_handle) as "publicId",
           max(payload->>'identity_revisit_at') as "lastCheckedAt",
           max(created_at)::text as "latestPendingAt"
    from noelle.leads
    where org_id = ${orgId} and agent_instance_id = ${instanceId}
      and platform = 'linkedin' and status = 'identity_pending'
      and external_id like 'browser:%'
      and payload->>'source' = 'extension_observed'
      and payload->'classifier'->>'provider' = 'jev'
      and author_handle ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,98}[A-Za-z0-9]$'
    group by lower(author_handle)
  `;
  const now = Date.now();
  const target = chooseDiscoveryTarget(profiles, keywords, Number(count[0]?.slot_count ?? 1), now, pendingProfiles);
  if (target?.source === "pending") {
    const revisitAt = new Date(now).toISOString();
    const marked = await sql<Array<{ id: string }>>`
      update noelle.leads
      set payload = payload || ${sql.json({ identity_revisit_at: revisitAt })}::jsonb
      where org_id = ${orgId} and agent_instance_id = ${instanceId}
        and platform = 'linkedin' and status = 'identity_pending'
        and external_id like 'browser:%'
        and payload->>'source' = 'extension_observed'
        and payload->'classifier'->>'provider' = 'jev'
        and lower(author_handle) = lower(${target.id})
      returning id
    `;
    if (marked.length === 0) return c.json({ target: null });
  } else if (target?.kind === "profile") {
    await sql`update noelle.linkedin_watchlist_people set last_checked_at = now()
      where id = ${target.id} and org_id = ${orgId} and agent_instance_id = ${instanceId}`;
  } else if (target?.kind === "keyword") {
    await sql`update noelle.linkedin_watchlist set last_checked_at = now()
      where id = ${target.id} and org_id = ${orgId} and agent_instance_id = ${instanceId}`;
  }
  return c.json({ target: target && { kind: target.kind, id: target.id, url: target.url } });
});

linkedinDiscovery.use("/api/actuator/observations", requireActuatorToken);
linkedinDiscovery.post("/api/actuator/observations", async (c) => {
  const parsed = batchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_observations" }, 400);
  const { instanceId, items } = parsed.data;
  const { orgId } = c.get("actuator");
  if (!(await ownsInstance(instanceId, orgId))) return c.json({ error: "instance_not_in_org" }, 403);
  const sql = noelleDb();
  let accepted = 0;
  let invalid = 0;
  for (const item of items) {
    const post = normalizeBrowserObservation(item, instanceId);
    const authorHandle = post?.authorHandle?.trim();
    // The LinkedIn writer requires a public author handle for OutboundIn.
    if (!post || !authorHandle) { invalid++; continue; }
    const payload = {
      source: "extension_observed",
      text: post.text,
      ...(post.urn ? { urn: post.urn } : {}),
      ...(post.url ? { url: post.url, original_post_url: post.url } : {}),
      ...(post.fingerprint ? { fingerprint: post.fingerprint } : {}),
      ...(post.reactionCount != null ? { reactionCount: post.reactionCount } : {}),
      ...(post.commentCount != null ? { commentCount: post.commentCount } : {}),
      posted_at: post.postedAt,
      authorName: post.authorName ?? null,
      authorHeadline: post.authorHeadline ?? null,
      authorPublicId: authorHandle,
    };
    const inserted = await sql<Array<{ id: string }>>`
      insert into noelle.leads
        (org_id, agent_instance_id, external_id, platform, author_handle, author_id,
         payload, status, priority)
      values (${orgId}, ${instanceId}, ${post.externalId}, 'linkedin',
        ${authorHandle}, ${post.authorId ?? null},
        ${sql.json(payload)}, 'observed', true)
      on conflict (org_id, platform, external_id) do nothing returning id
    `;
    accepted += inserted.length;
    await sql`
      update noelle.linkedin_watchlist_people
      set latest_observed_post_at = case
            when ${post.postedAt}::timestamptz is not null
              and (latest_observed_post_at is null or latest_observed_post_at < ${post.postedAt}::timestamptz)
            then ${post.postedAt}::timestamptz else latest_observed_post_at end,
          latest_observed_urn = coalesce(${post.urn ?? null}, latest_observed_urn)
      where org_id = ${orgId} and agent_instance_id = ${instanceId}
        and (fsd_profile_id = ${post.authorId ?? ""} or public_id = ${authorHandle})
    `;
  }
  if (accepted > 0) await sql`select pg_notify('noelle_linkedin_observed', ${instanceId})`;
  return c.json({ accepted, duplicates: items.length - accepted - invalid, invalid });
});

const identitySchema = z.object({
  instanceId: z.string().uuid(),
  leadId: z.string().uuid(),
  fingerprint: z.string().min(1).max(500),
  urn: z.string().max(150).optional(),
  url: z.string().max(1000).optional(),
  shortUrl: z.string().max(200).optional(),
}).refine((input) => input.shortUrl
  ? !input.urn && !input.url
  : Boolean(input.urn || input.url));

linkedinDiscovery.use("/api/actuator/discovery-identities", requireActuatorToken);
linkedinDiscovery.get("/api/actuator/discovery-identities", async (c) => {
  const instanceId = c.req.query("instanceId");
  if (!instanceId || !z.string().uuid().safeParse(instanceId).success) {
    return c.json({ error: "invalid_instance_id" }, 400);
  }
  const rawFingerprints = c.req.query("fingerprints");
  let fingerprints: string[] | null = null;
  if (rawFingerprints !== undefined) {
    let value: unknown;
    try { value = JSON.parse(rawFingerprints); } catch { return c.json({ error: "invalid_fingerprints" }, 400); }
    const parsed = z.array(z.string().min(1).max(500)).min(1).max(50).safeParse(value);
    if (!parsed.success) return c.json({ error: "invalid_fingerprints" }, 400);
    fingerprints = [...new Set(parsed.data)];
  }
  const { orgId } = c.get("actuator");
  if (!(await ownsInstance(instanceId, orgId))) return c.json({ error: "instance_not_in_org" }, 403);
  const candidates = await noelleDb()<Array<{ leadId: string; fingerprint: string; status: string }>>`

import { Hono } from "hono";
import { z } from "zod";
import { noelleDb } from "../lib/db.js";
import { requireActuatorToken, type ActuatorContext } from "../middleware/actuator.js";
import { chooseXDiscoveryTarget, normalizeXObservation, type XKeywordTarget, type XProfileTarget } from "./x-discovery.js";
import { discoveryReplyCapacity } from "./discovery-capacity.js";

export const xDiscovery = new Hono<{ Variables: { actuator: ActuatorContext } }>();

const observationSchema = z.object({
  tweetId: z.string().min(1).max(25),
  url: z.string().min(1).max(1000),
  text: z.string().min(1).max(25_000),
  authorHandle: z.string().min(1).max(50),
  authorName: z.string().max(300).optional(),
  authorId: z.string().max(100).optional(),
  postedAt: z.string().max(100).optional(),
  likeCount: z.number().optional(),
  replyCount: z.number().optional(),
});
const batchSchema = z.object({
  instanceId: z.string().uuid(),
  items: z.array(z.unknown()).min(1).max(50),
});

async function ownsXInstance(instanceId: string, orgId: string): Promise<boolean> {
  const rows = await noelleDb()<Array<{ id: string }>>`
    select id from noelle.agent_instances
    where id = ${instanceId} and org_id = ${orgId} and role = 'x_intern' limit 1
  `;
  return rows.length === 1;
}

xDiscovery.use("/api/x-actuator/discovery-capacity", requireActuatorToken);
xDiscovery.get("/api/x-actuator/discovery-capacity", async (c) => {
  const instanceId = c.req.query("instanceId");
  if (!instanceId || !z.string().uuid().safeParse(instanceId).success) return c.json({ error: "invalid_instance_id" }, 400);
  const { orgId } = c.get("actuator");
  if (!(await ownsXInstance(instanceId, orgId))) return c.json({ error: "instance_not_in_org" }, 403);
  return c.json(await discoveryReplyCapacity(noelleDb(), { orgId, instanceId, platform: "x" }));
});

xDiscovery.use("/api/x-actuator/discovery-target", requireActuatorToken);
xDiscovery.get("/api/x-actuator/discovery-target", async (c) => {
  const instanceId = c.req.query("instanceId");
  if (!instanceId || !z.string().uuid().safeParse(instanceId).success) return c.json({ error: "invalid_instance_id" }, 400);
  const { orgId } = c.get("actuator");
  if (!(await ownsXInstance(instanceId, orgId))) return c.json({ error: "instance_not_in_org" }, 403);
  const sql = noelleDb();
  const count = await sql<Array<{ slot_count: string }>>`
    insert into noelle.x_discovery_schedule (org_id, agent_instance_id, slot_count)
    values (${orgId}, ${instanceId}, 1)
    on conflict (agent_instance_id) do update
      set slot_count = noelle.x_discovery_schedule.slot_count + 1, updated_at = now()
    returning slot_count::text
  `;
  const profiles = await sql<XProfileTarget[]>`
    select handle, max(last_checked_at)::text as "lastCheckedAt",
           max(latest_observed_post_at)::text as "latestObservedPostAt"
    from (
      select lower(btrim(handle, '@ ')) as handle, last_checked_at, latest_observed_post_at
      from noelle.x_watchlist_people where org_id = ${orgId} and agent_instance_id = ${instanceId}
      union all
      select lower(btrim(value, '@ ')) as handle, last_checked_at, latest_observed_post_at
      from noelle.x_watchlist where org_id = ${orgId} and agent_instance_id = ${instanceId} and kind = 'handle'
    ) watched
    where handle ~ '^[a-z0-9_]{1,15}$'
    group by handle
  `;
  const keywords = await sql<XKeywordTarget[]>`
    select value, last_checked_at::text as "lastCheckedAt"
    from noelle.x_watchlist where org_id = ${orgId} and agent_instance_id = ${instanceId} and kind = 'keyword'
  `;
  const target = chooseXDiscoveryTarget(profiles, keywords, Number(count[0]?.slot_count ?? 1), Date.now());
  if (target?.kind === "profile") {
    await sql`update noelle.x_watchlist_people set last_checked_at = now()
      where org_id = ${orgId} and agent_instance_id = ${instanceId} and lower(btrim(handle, '@ ')) = ${target.handle}`;
    await sql`update noelle.x_watchlist set last_checked_at = now()
      where org_id = ${orgId} and agent_instance_id = ${instanceId} and kind = 'handle'
        and lower(btrim(value, '@ ')) = ${target.handle}`;
  } else if (target?.kind === "keyword") {
    await sql`update noelle.x_watchlist set last_checked_at = now()
      where org_id = ${orgId} and agent_instance_id = ${instanceId} and kind = 'keyword' and value = ${target.value}`;
  }
  return c.json({ target });
});

xDiscovery.use("/api/x-actuator/observations", requireActuatorToken);
xDiscovery.post("/api/x-actuator/observations", async (c) => {
  const parsed = batchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_observations" }, 400);
  const { instanceId, items } = parsed.data;
  const { orgId } = c.get("actuator");
  if (!(await ownsXInstance(instanceId, orgId))) return c.json({ error: "instance_not_in_org" }, 403);
  const sql = noelleDb();
  let accepted = 0;
  let invalid = 0;
  for (const raw of items) {
    const parsedItem = observationSchema.safeParse(raw);
    if (!parsedItem.success) { invalid++; continue; }
    const post = normalizeXObservation(parsedItem.data);
    if (!post) { invalid++; continue; }
    const payload = {
      source: "extension_observed", text: post.text, url: post.url, posted_at: post.postedAt,
      authorName: post.authorName ?? null, authorHandle: post.authorHandle,
      likeCount: post.likeCount ?? null, replyCount: post.replyCount ?? null,
    };
    const inserted = await sql<Array<{ id: string }>>`
      insert into noelle.leads
        (org_id, agent_instance_id, external_id, platform, author_handle, author_id, payload, status, priority)
      values (${orgId}, ${instanceId}, ${post.tweetId}, 'x', ${post.authorHandle},
        ${post.authorId ?? null}, ${sql.json(payload)}, 'observed', true)
      on conflict (org_id, platform, external_id) do nothing returning id
    `;
    accepted += inserted.length;
    await sql`update noelle.x_watchlist_people
      set latest_observed_post_at = case when ${post.postedAt}::timestamptz is not null
        and (latest_observed_post_at is null or latest_observed_post_at < ${post.postedAt}::timestamptz)
        then ${post.postedAt}::timestamptz else latest_observed_post_at end,
        latest_observed_tweet_id = case when ${post.postedAt}::timestamptz is not null
        and (latest_observed_post_at is null or latest_observed_post_at < ${post.postedAt}::timestamptz)
        then ${post.tweetId} else latest_observed_tweet_id end
      where org_id = ${orgId} and agent_instance_id = ${instanceId}
        and lower(btrim(handle, '@ ')) = ${post.authorHandle}`;
    await sql`update noelle.x_watchlist
      set latest_observed_post_at = case when ${post.postedAt}::timestamptz is not null
        and (latest_observed_post_at is null or latest_observed_post_at < ${post.postedAt}::timestamptz)
        then ${post.postedAt}::timestamptz else latest_observed_post_at end,
        latest_observed_tweet_id = case when ${post.postedAt}::timestamptz is not null
        and (latest_observed_post_at is null or latest_observed_post_at < ${post.postedAt}::timestamptz)
        then ${post.tweetId} else latest_observed_tweet_id end
      where org_id = ${orgId} and agent_instance_id = ${instanceId} and kind = 'handle'
        and lower(btrim(value, '@ ')) = ${post.authorHandle}`;
  }
  if (accepted > 0) await sql`select pg_notify('noelle_x_observed', ${instanceId})`;
  return c.json({ accepted, duplicates: items.length - accepted - invalid, invalid });
});

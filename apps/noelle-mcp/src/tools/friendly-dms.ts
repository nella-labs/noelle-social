import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NoelleError, type NoelleContext } from "../context.js";
import { pollUntil } from "../poll.js";
import { guard, text } from "../result.js";
import type { ToolModule, ToolResult } from "../types.js";
import { AGENT_SELECTOR_PROPS, LIMIT_PROP, ORG_PROP, limitOf, optNum, optStr, reqBool, resolveAgentInstance } from "./_shared.js";

type Platform = "x" | "linkedin";
const ROLE: Record<Platform, string> = { x: "x_intern", linkedin: "linkedin_intern" };
const CAP: Record<Platform, number> = { x: 15, linkedin: 40 };

const platformProp = { type: "string", enum: ["x", "linkedin"], description: "Friendly DM platform." } as const;
const tools: Tool[] = [
  {
    name: "noelle_set_friendly_dms",
    description: "Enable or disable the recurring saved-context Friendly DM lane.",
    inputSchema: {
      type: "object",
      properties: { org: ORG_PROP, ...AGENT_SELECTOR_PROPS, platform: platformProp, enabled: { type: "boolean" } },
      required: ["platform", "enabled"],
    },
  },
  {
    name: "noelle_request_friendly_dms",
    description: "Create a one-off durable Friendly DM request without enabling the recurring lane.",
    inputSchema: {
      type: "object",
      properties: { org: ORG_PROP, ...AGENT_SELECTOR_PROPS, platform: platformProp, personId: { type: "string" }, handle: { type: "string" }, count: { type: "number" }, waitSeconds: { type: "number" } },
      required: ["platform"],
    },
  },
  {
    name: "noelle_list_friendly_dms",
    description: "List Friendly DM requests, draft bodies, review status, and check verdict.",
    inputSchema: {
      type: "object",
      properties: { org: ORG_PROP, platform: platformProp, requestId: { type: "string" }, status: { type: "string", enum: ["pending", "running", "done", "cancelled"] }, waitSeconds: { type: "number" }, limit: LIMIT_PROP },
    },
  },
];

function platformOf(args: Record<string, unknown>): Platform {
  const platform = optStr(args, "platform");
  if (platform !== "x" && platform !== "linkedin") {
    throw new NoelleError('platform must be "x" or "linkedin".');
  }
  return platform;
}

function normalizeHandle(handle?: string): string | null {
  const out = handle?.trim().replace(/^@+/, "").toLowerCase();
  return out || null;
}

function countOf(args: Record<string, unknown>, platform: Platform): number {
  const raw = optNum(args, "count") ?? 1;
  return Math.max(1, Math.min(CAP[platform], Math.floor(raw)));
}

async function friendlyAgent(ctx: NoelleContext, orgId: string, platform: Platform, args: Record<string, unknown>) {
  const explicit = optStr(args, "role") || optStr(args, "agentRole") || optStr(args, "agentInstanceId") || optStr(args, "instanceId");
  const agent = await resolveAgentInstance(ctx, orgId, explicit ? args : { role: ROLE[platform] });
  if (agent.role !== ROLE[platform]) {
    throw new NoelleError(`${platform} Friendly DMs require ${ROLE[platform]}, not ${agent.role}.`);
  }
  return agent;
}

async function setFriendlyDms(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  ctx.assertWritable("set friendly DMs");
  const platform = platformOf(args);
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const agent = await friendlyAgent(ctx, org.orgId, platform, args);
  const enabled = reqBool(args, "enabled");
  const [row] = await ctx.sql<Array<{ enabled: boolean }>>`
    update noelle.agent_instances
    set lane_config = jsonb_set(
      jsonb_set(coalesce(lane_config, '{}'::jsonb), '{dms}', coalesce(lane_config->'dms', '{}'::jsonb), true),
      '{dms,relationship_dms_enabled}', to_jsonb(${enabled}::boolean), true
    )
    where org_id = ${org.orgId} and id = ${agent.id}
    returning ((lane_config #>> '{dms,relationship_dms_enabled}')::boolean) as enabled`;
  return text(`${agent.display_name ?? agent.role} ${platform} Friendly DMs ${row?.enabled ? "enabled" : "disabled"}.`);
}

async function requestFriendlyDms(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  ctx.assertWritable("request friendly DMs");
  const platform = platformOf(args);
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const agent = await friendlyAgent(ctx, org.orgId, platform, args);
  const personId = optStr(args, "personId") ?? null;
  const recipientKey = normalizeHandle(optStr(args, "handle"));
  let authorId: string | null = null;
  if (personId) {
    const [person] = await ctx.sql<Array<{ id: string; key: string | null; author_id: string | null }>>`
      select p.id::text, lower(regexp_replace(trim(coalesce(a.handle,
        case when a.platform = 'linkedin' then regexp_replace(split_part(split_part(coalesce(a.url, ''), 'linkedin.com/in/', 2), '/', 1), '[?#].*$', '')
             when a.platform = 'x' then regexp_replace(coalesce(nullif(split_part(split_part(coalesce(a.url, ''), 'x.com/', 2), '/', 1), ''), split_part(split_part(coalesce(a.url, ''), 'twitter.com/', 2), '/', 1)), '[?#].*$', '') end)), '^@+', '')) as key,
        null::text as author_id
      from noelle.persons p left join noelle.person_social_accounts a
        on a.person_id = p.id and a.org_id = p.org_id and a.platform = ${platform}
      where p.org_id = ${org.orgId} and p.id = ${personId} limit 1`;
    if (!person) throw new NoelleError(`Person ${personId} not found in ${org.name}.`);
    authorId = person.author_id;
  }
  const [row] = await ctx.sql<Array<{ id: string }>>`
    insert into noelle.relationship_dm_requests
      (org_id, agent_instance_id, platform, person_id, recipient_key, author_id, requested_count, created_by)
    values (${org.orgId}, ${agent.id}, ${platform}, ${personId}::uuid, ${recipientKey}, ${authorId}, ${countOf(args, platform)}, ${ctx.operatorId()})
    returning id::text`;
  const requestId = row?.id;
  if (!requestId) throw new NoelleError("Friendly DM request was not created.");
  const view = await readFriendlyDms({ orgId: org.orgId, requestId, waitSeconds: optNum(args, "waitSeconds") }, ctx);
  return text(JSON.stringify({ requestId, requests: view }, null, 2));
}

type FriendlyDmRow = {
  id: string;
  platform: Platform;
  role: string;
  status: string;
  requested_count: number;
  processed_count: number;
  queued_count: number;
  skipped_count: number;
  failed_count: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
  outputs: unknown[];
};

async function readFriendlyDms(
  args: { orgId: string; requestId?: string; platform?: Platform; status?: string; waitSeconds?: number; limit?: number },
  ctx: NoelleContext,
): Promise<FriendlyDmRow[]> {
  const read = () => ctx.sql<FriendlyDmRow[]>`
    select r.id::text, r.platform, ai.role, r.status, r.requested_count, r.processed_count,
      r.queued_count, r.skipped_count, r.failed_count, r.reason, r.created_at::text, r.updated_at::text,
      coalesce(json_agg(json_build_object(
        'reservationId', res.id::text,
        'reservationStatus', res.status,
        'recipient', res.recipient_key,
        'judgeVerdict', res.judge_verdict,
        'leadId', l.id::text,
        'sourceText', coalesce(l.payload->>'text', l.payload->>'original_post_text', l.payload->>'originalPostText'),
        'sourceUrl', coalesce(l.payload->>'url', l.payload->>'original_post_url', l.payload->>'originalPostUrl'),
        'draftId', d.id::text,
        'draftBody', coalesce(nullif(d.payload->>'edited_body', ''), d.payload->>'body'),
        'approvalId', ap.id::text,
        'reviewStatus', ap.status
      ) order by res.reserved_at asc) filter (where res.id is not null), '[]'::json) as outputs
    from noelle.relationship_dm_requests r
    join noelle.agent_instances ai on ai.id = r.agent_instance_id and ai.org_id = r.org_id
    left join noelle.relationship_dm_reservations res on res.request_id = r.id
    left join noelle.leads l on l.org_id = r.org_id and l.external_id = 'relationship-dm:' || res.id::text
    left join noelle.drafts d on d.org_id = r.org_id and d.lead_id = l.id and coalesce(d.payload->>'kind', 'reply') = 'dm'
    left join noelle.approvals ap on ap.org_id = r.org_id and ap.draft_id = d.id
    where r.org_id = ${args.orgId}
      and (${args.requestId ?? null}::uuid is null or r.id = ${args.requestId ?? null}::uuid)
      and (${args.platform ?? null}::text is null or r.platform = ${args.platform ?? null})
      and (${args.status ?? null}::text is null or r.status = ${args.status ?? null})
    group by r.id, ai.role
    order by r.created_at desc
    limit ${args.limit ?? 50}`;
  return pollUntil(
    read,
    (rows) => !args.waitSeconds || rows.some((r) => ["done", "cancelled"].includes(r.status) || r.outputs.length > 0),
    args.waitSeconds,
  );
}

async function listFriendlyDms(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const platformArg = optStr(args, "platform");
  if (platformArg && platformArg !== "x" && platformArg !== "linkedin") throw new NoelleError('platform must be "x" or "linkedin".');
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const rows = await readFriendlyDms(
    { orgId: org.orgId, requestId: optStr(args, "requestId"), platform: platformArg as Platform | undefined, status: optStr(args, "status"), waitSeconds: optNum(args, "waitSeconds"), limit: limitOf(args, 20, 100) },
    ctx,
  );
  return text(JSON.stringify({ requests: rows }, null, 2));
}

async function handle(name: string, args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult | null> {
  switch (name) {
    case "noelle_set_friendly_dms": return guard(() => setFriendlyDms(args, ctx));
    case "noelle_request_friendly_dms": return guard(() => requestFriendlyDms(args, ctx));
    case "noelle_list_friendly_dms": return guard(() => listFriendlyDms(args, ctx));
    default: return null;
  }
}

export const friendlyDmsModule: ToolModule = { tools, handle };

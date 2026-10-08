import {
  skipApproval,
  restoreSkippedApproval,
  parkApprovalDm,
  saveApprovalEdit,
  bulkSkipApprovals,
} from "@noelle/runtime";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NoelleError, type NoelleContext } from "../context.js";
import type { ToolModule, ToolResult } from "../types.js";
import { guard, mdFields, mdTable, text, truncate } from "../result.js";
import { LIMIT_PROP, ORG_PROP, limitOf, optNum, optStr, optStrArray, reqStr } from "./_shared.js";
import { queueApprovedReply } from "./approval-send.js";

// For X and LinkedIn replies, pending approvals are automatic-review passes
// ready for the actor. DMs remain manual. Each row points at a draft
// (noelle.drafts, content in `payload` jsonb) and its source lead
// (noelle.leads). Statuses: pending | sent | skipped | deferred | expired |
// errored (never "approved"). "Sending" delegates to the API when configured,
// otherwise it releases the X actuator queue.

// The shared column list returned by the list/get selects. classifier_score is
// numeric → arrives as a string; jsonb text extracts (body/kind/lead_text) are
// nullable when the join misses.
interface ApprovalRow {
  a_id: string;
  a_status: string;
  a_decided_by: string | null;
  a_auto: string | null;
  a_created_at: string;
  a_lead_id: string | null;
  a_draft_id: string | null;
  body: string | null;
  kind: string;
  platform: string | null;
  source_url: string | null;
  review_pass: boolean | string | null;
  review_reasons: unknown;
  review_attempts: string | null;
  dm_writing_pass: boolean | string | null;
  dm_writing_stale: boolean;
  dm_writing_reasons: unknown;
  dm_writing_attempts: string | null;
  l_external_id: string | null;
  l_author_handle: string | null;
  l_tier: string | null;
  l_label: string | null;
  l_score: string | null;
  l_priority: boolean | null;
  lead_text: string | null;
}

type ApprovalPlatform = "x" | "linkedin" | "reddit" | "all";

function approvalPlatform(args: Record<string, unknown>): ApprovalPlatform {
  const platform = optStr(args, "platform") ?? "x";
  if (platform === "x" || platform === "linkedin" || platform === "reddit" || platform === "all")
    return platform;
  throw new NoelleError(`Unsupported approval platform: ${platform}`);
}

function renderReview(row: ApprovalRow): string {
  // Older companion DMs inherited the reply set's verifier_meta. It is not a
  // review of this DM; show only the separate DM wording check here.
  const isDm = row.kind === "dm";
  if (isDm && row.dm_writing_stale) return "writing check: unavailable (edited)";
  const pass = isDm ? row.dm_writing_pass : row.review_pass;
  if (pass === null || pass === undefined) return isDm ? "writing check: unavailable" : "";
  const passed = pass === true || pass === "true";
  const rawReasons = isDm ? row.dm_writing_reasons : row.review_reasons;
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter((r): r is string => typeof r === "string")
    : [];
  const count = isDm ? row.dm_writing_attempts : row.review_attempts;
  const attempts = count ? `, ${isDm ? "rewrites" : "attempts"}: ${count}` : "";
  return `${isDm ? "writing check" : "review"}: ${passed ? "pass" : "fail"}${attempts}${isDm ? " (wording only; grounding not assessed)" : ""}${reasons.length ? ` — ${reasons.join("; ")}` : ""}`;
}

const APPROVAL_ID_PROP = {
  type: "string",
  description: "The approval row id (uuid).",
} as const;

const tools: Tool[] = [
  {
    name: "noelle_list_approvals",
    description:
      "List the reply/DM approval queue for an org. A pending X or LinkedIn reply already passed automatic review and is ready for its actor; DMs remain manual. Defaults to pending, highest classifier score first. Filter by platform (x/linkedin/reddit/all), status (pending/sent/skipped/all), watchlist membership, and a minimum classifier score. Shows author, source lead score, draft kind, source platform, body snippet, and available checks. A DM writing check assesses wording only, not grounding; use the Friendly DM tool for its evidence judge.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        platform: {
          type: "string",
          enum: ["x", "linkedin", "reddit", "all"],
          description: "Platform queue to read. Default: x.",
        },
        status: {
          type: "string",
          enum: ["pending", "sent", "skipped", "all"],
          description: "Filter by approval status. Default: pending.",
        },
        watchlist: {
          type: "string",
          enum: ["all", "only", "exclude"],
          description:
            "Filter by watchlist/priority lead: only (priority leads), exclude (non-priority), or all. Default: all.",
        },
        minScore: {
          type: "number",
          description: "Only show approvals whose lead classifier_score is >= this (0..1).",
        },
        limit: LIMIT_PROP,
      },
    },
  },
  {
    name: "noelle_get_approval",
    description:
      "Get one approval in full: the source lead (author, score, text) plus every draft angle generated for that lead (each with its own approval_id, kind, status, and full body). Use this before send/skip/edit.",
    inputSchema: {
      type: "object",
      properties: { org: ORG_PROP, approvalId: APPROVAL_ID_PROP },
      required: ["approvalId"],
    },
  },
  {
    name: "noelle_send_draft",
    description:
      "Manually send or release an already-approved X reply. With local API delegation configured this submits the send request; otherwise it releases the reply to the local browser actuator under existing sender gates. A queue result is not delivery proof. Optionally override the body. DM sends require API delegation.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        approvalId: APPROVAL_ID_PROP,
        body: {
          type: "string",
          description: "Optional override body to send instead of the current draft.",
        },
      },
      required: ["approvalId"],
    },
  },
  {
    name: "noelle_skip_draft",
    description:
      "Skip an approval (status=skipped). If the approval has a lead, skips all pending reply angles for that lead (not DMs). Optionally record a reason.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        approvalId: APPROVAL_ID_PROP,
        reason: { type: "string", description: "Optional skip reason recorded on the row(s)." },
      },
      required: ["approvalId"],
    },
  },
  {
    name: "noelle_park_draft",
    description:
      "Defer an approval (status=deferred) to revisit later, without skipping or sending it.",
    inputSchema: {
      type: "object",
      properties: { org: ORG_PROP, approvalId: APPROVAL_ID_PROP },
      required: ["approvalId"],
    },
  },
  {
    name: "noelle_unskip_draft",
    description:
      "Restore a skipped approval back to pending. If it has a lead, restores all skipped reply angles for that lead (not DMs).",
    inputSchema: {
      type: "object",
      properties: { org: ORG_PROP, approvalId: APPROVAL_ID_PROP },
      required: ["approvalId"],
    },
  },
  {
    name: "noelle_edit_draft",
    description:
      "Edit a draft's body in place (stored as edited_body on the draft payload) without sending. Only allowed while the approval is pending or deferred.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        approvalId: APPROVAL_ID_PROP,
        body: { type: "string", description: "The new draft body." },
      },
      required: ["approvalId", "body"],
    },
  },
  {
    name: "noelle_mark_sent",
    description:
      "Record a manual send for an approval (no live post). Marks the approval sent, stamps the draft's sent_external_id (from a tweet URL if given, else a manual: sentinel), and skips the lead's sibling reply angles.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        approvalId: APPROVAL_ID_PROP,
        tweetUrl: {
          type: "string",
          description: "Optional URL of the posted tweet; its status id is extracted and recorded.",
        },
      },
      required: ["approvalId"],
    },
  },
  {
    name: "noelle_bulk_skip",
    description:
      "Skip many approvals at once by id (1..200). Skips all pending reply angles (not DMs) for the leads behind the given approval ids. Returns how many rows were skipped.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        approvalIds: {
          type: "array",
          items: { type: "string" },
          description: "Approval row ids to skip (1..200).",
        },
        reason: { type: "string", description: "Optional skip reason (default 'bulk-skip')." },
      },
      required: ["approvalIds"],
    },
  },
];

async function listApprovals(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const platform = approvalPlatform(args);
  const status = optStr(args, "status") ?? "pending";
  const watchlist = optStr(args, "watchlist") ?? "all";
  const minScore = optNum(args, "minScore") ?? null;
  const limit = limitOf(args);

  const rows = await ctx.sql<Array<ApprovalRow>>`
    select a.id a_id, a.status a_status, a.decided_by a_decided_by, a.auto_send_target_at a_auto,
      a.created_at::text a_created_at, a.lead_id a_lead_id, a.draft_id a_draft_id,
      coalesce(d.payload->>'edited_body', d.payload->>'body') as body,
      coalesce(d.payload->>'kind','reply') as kind,
      coalesce(l.platform,'x') as platform,
      coalesce(l.payload->>'url', l.payload->>'original_post_url') as source_url,
      d.payload->'verifier_meta'->>'pass' as review_pass,
      d.payload->'verifier_meta'->'reasons' as review_reasons,
      d.payload->'verifier_meta'->>'attempts' as review_attempts,
      d.payload->'dm_voice_check'->>'pass' as dm_writing_pass,
      coalesce(d.payload->>'edited_body', d.payload->>'body') is distinct from d.payload->>'body' as dm_writing_stale,
      d.payload->'dm_voice_check'->'reasons' as dm_writing_reasons,
      d.payload->'dm_voice_check'->>'attempts' as dm_writing_attempts,
      l.external_id l_external_id, l.author_handle l_author_handle, l.tier l_tier,
      l.classifier_label l_label, l.classifier_score l_score, l.priority l_priority,
      l.payload->>'text' as lead_text
    from noelle.approvals a
    left join noelle.drafts d on d.id = a.draft_id
    left join noelle.leads  l on l.id = d.lead_id
    where a.org_id = ${org.orgId}
      and (${platform} = 'all' or coalesce(l.platform,'x') = ${platform})
      and (${status} = 'all' or a.status = ${status})
      and (${watchlist} = 'all' or (${watchlist}='only' and l.priority = true)
           or (${watchlist}='exclude' and (l.priority is null or l.priority = false)))
      and (${minScore}::numeric is null or l.classifier_score is null or l.classifier_score >= ${minScore}::numeric)
    order by case when a.status='pending' then 0 else 1 end, l.classifier_score desc nulls last, a.created_at desc
    limit ${limit}`;

  const table = mdTable(
    ["approval_id", "platform", "author", "lead score", "kind", "status", "snippet", "check"],
    rows.map((r) => [
      r.a_id,
      r.platform ?? "x",
      r.l_author_handle ? `@${r.l_author_handle}` : "—",
      r.l_score ?? "—",
      r.kind,
      r.a_status,
      truncate(r.body, 80),
      renderReview(r),
    ]),
  );
  return text(
    `**${org.name}** — ${rows.length} approval(s) [platform=${platform}, status=${status}]\n\n${table}`,
  );
}

async function getApproval(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const approvalId = reqStr(args, "approvalId");

  const rows = await ctx.sql<Array<ApprovalRow>>`
    select a.id a_id, a.status a_status, a.decided_by a_decided_by, a.auto_send_target_at a_auto,
      a.created_at::text a_created_at, a.lead_id a_lead_id, a.draft_id a_draft_id,
      coalesce(d.payload->>'edited_body', d.payload->>'body') as body,
      coalesce(d.payload->>'kind','reply') as kind,
      coalesce(l.platform,'x') as platform,
      coalesce(l.payload->>'url', l.payload->>'original_post_url') as source_url,
      d.payload->'verifier_meta'->>'pass' as review_pass,
      d.payload->'verifier_meta'->'reasons' as review_reasons,
      d.payload->'verifier_meta'->>'attempts' as review_attempts,
      d.payload->'dm_voice_check'->>'pass' as dm_writing_pass,
      coalesce(d.payload->>'edited_body', d.payload->>'body') is distinct from d.payload->>'body' as dm_writing_stale,
      d.payload->'dm_voice_check'->'reasons' as dm_writing_reasons,
      d.payload->'dm_voice_check'->>'attempts' as dm_writing_attempts,
      l.external_id l_external_id, l.author_handle l_author_handle, l.tier l_tier,
      l.classifier_label l_label, l.classifier_score l_score, l.priority l_priority,
      l.payload->>'text' as lead_text
    from noelle.approvals a
    left join noelle.drafts d on d.id = a.draft_id
    left join noelle.leads  l on l.id = d.lead_id
    where a.id = ${approvalId} and a.org_id = ${org.orgId}`;

  const main = rows[0];
  if (!main) throw new NoelleError(`Approval ${approvalId} not found in ${org.name}.`);

  let angles: ApprovalRow[] = rows;
  if (main.a_lead_id) {
    angles = await ctx.sql<Array<ApprovalRow>>`
      select a.id a_id, a.status a_status, a.decided_by a_decided_by, a.auto_send_target_at a_auto,
        a.created_at::text a_created_at, a.lead_id a_lead_id, a.draft_id a_draft_id,
        coalesce(d.payload->>'edited_body', d.payload->>'body') as body,
        coalesce(d.payload->>'kind','reply') as kind,
        d.payload->'verifier_meta'->>'pass' as review_pass,
        d.payload->'verifier_meta'->'reasons' as review_reasons,
        d.payload->'verifier_meta'->>'attempts' as review_attempts,
        d.payload->'dm_voice_check'->>'pass' as dm_writing_pass,
      coalesce(d.payload->>'edited_body', d.payload->>'body') is distinct from d.payload->>'body' as dm_writing_stale,
        d.payload->'dm_voice_check'->'reasons' as dm_writing_reasons,
        d.payload->'dm_voice_check'->>'attempts' as dm_writing_attempts,
        l.external_id l_external_id, l.author_handle l_author_handle, l.tier l_tier,
        l.classifier_label l_label, l.classifier_score l_score, l.priority l_priority,
        l.payload->>'text' as lead_text
      from noelle.approvals a
      left join noelle.drafts d on d.id = a.draft_id
      left join noelle.leads  l on l.id = d.lead_id
      where a.org_id = ${org.orgId} and a.lead_id = ${main.a_lead_id}
      order by a.created_at asc`;
  }

  const header = [
    `## Approval ${main.a_id}`,
    `- **platform:** ${main.platform ?? "x"}`,
    `- **author:** ${main.l_author_handle ? `@${main.l_author_handle}` : "—"}`,
    `- **lead score:** ${main.l_score ?? "—"} · **tier:** ${main.l_tier ?? "—"} · **label:** ${main.l_label ?? "—"}`,
    `- **lead:** ${main.l_external_id ?? "—"}`,
    `- **source:** ${main.source_url ?? "—"}`,
    "",
    `**Lead text:**`,
    main.lead_text ?? "_none_",
    "",
    `### Angles (${angles.length})`,
  ].join("\n");

  const angleBlocks = angles
    .map((a) =>
      [
        `#### ${a.kind} — ${a.a_status}  (approval_id: ${a.a_id})`,
        renderReview(a),
        a.body ?? "_no body_",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

  return text(`${header}\n\n${angleBlocks}`);
}

interface SendFetchRow {
  lead_id: string | null;
  status: string;
  kind: string;
  draft_id: string | null;
  external_id: string | null;
  body: string | null;
  platform: string | null;
}

async function sendDraft(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  ctx.assertWritable("send a draft");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const approvalId = reqStr(args, "approvalId");
  const providedBody = optStr(args, "body");
  const provided = providedBody !== undefined;

  const fetched = await ctx.sql<Array<SendFetchRow>>`
    select a.lead_id, a.status, coalesce(d.payload->>'kind','reply') as kind, d.id as draft_id,
      l.external_id, coalesce(d.payload->>'edited_body', d.payload->>'body') as body,
      coalesce(l.platform,'x') as platform
    from noelle.approvals a
    left join noelle.drafts d on d.id = a.draft_id
    left join noelle.leads l on l.id = d.lead_id
    where a.id = ${approvalId} and a.org_id = ${org.orgId}`;
  const row = fetched[0];
  if (!row) throw new NoelleError(`Approval ${approvalId} not found in ${org.name}.`);
  if (row.status !== "pending")
    throw new NoelleError(`Approval ${approvalId} is ${row.status}, not pending — cannot send.`);
  if ((row.platform ?? "x") !== "x") {
    throw new NoelleError(
      "noelle_send_draft only queues or sends X drafts. Use the platform review UI/manual send flow, then noelle_mark_sent if you need to record it.",

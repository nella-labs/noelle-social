import { NoelleError, type NoelleContext } from "../context.js";
import { pollUntil } from "../poll.js";
import { mdFields, text } from "../result.js";
import type { ToolResult } from "../types.js";
import { optNum, optStr, reqStr } from "./_shared.js";

type ReplyPlatform = "x" | "linkedin";

interface LeadRow {
  id: string;
  platform: string | null;
  status: string | null;
  author_handle: string | null;
  payload: Record<string, unknown> | null;
}

interface DraftRow {
  a_id: string;
  a_status: string;
  kind: string;
  body: string | null;
  review_pass: boolean | string | null;
  review_reasons: unknown;
  review_attempts: string | null;
}

interface RequestStatus {
  orgName: string;
  handle: string;
  state: string;
  lead: LeadRow;
  request: Record<string, unknown>;
  drafts: DraftRow[];
}

function assertReplyPlatform(value: string | null | undefined): ReplyPlatform {
  if (value === "x" || value === "linkedin") return value;
  throw new NoelleError(
    `Reply requests are supported for x and linkedin leads only (got ${value ?? "missing"}).`,
  );
}

function readWaitSeconds(args: Record<string, unknown>): number {
  const n = optNum(args, "waitSeconds") ?? 0;
  if (n < 0 || n > 45) throw new NoelleError("waitSeconds must be between 0 and 45.");
  return Math.floor(n);
}

function readRequestKey(args: Record<string, unknown>, leadId: string): string {
  const key = optStr(args, "requestKey") ?? leadId;
  if (key.length > 200) throw new NoelleError("requestKey must be 200 characters or fewer.");
  return key;
}

function payloadOf(lead: LeadRow): Record<string, unknown> {
  return lead.payload && typeof lead.payload === "object" ? lead.payload : {};
}

function storedRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const request = payload.reply_request;
  return request && typeof request === "object" && !Array.isArray(request)
    ? (request as Record<string, unknown>)
    : {};
}

function reviewValue(draft: DraftRow): boolean | null {
  if (draft.review_pass === null || draft.review_pass === undefined) return null;
  return draft.review_pass === true || draft.review_pass === "true";
}

function reviewLine(draft: DraftRow): string {
  if (draft.review_pass === null || draft.review_pass === undefined) return "review: pending";
  const passed = reviewValue(draft) === true;
  const reasons = Array.isArray(draft.review_reasons)
    ? draft.review_reasons.filter((r): r is string => typeof r === "string")
    : [];
  const attempts = draft.review_attempts ? `, attempts: ${draft.review_attempts}` : "";
  return `review: ${passed ? "pass" : "fail"}${attempts}${reasons.length ? ` — ${reasons.join("; ")}` : ""}`;
}

function sourceLine(lead: LeadRow): string {
  const payload = payloadOf(lead);
  const post = typeof payload.text === "string" ? payload.text : null;
  const url = typeof payload.url === "string" ? payload.url : null;
  return [post ? `source_post: ${post}` : null, url ? `source_url: ${url}` : null]
    .filter(Boolean)
    .join("\n");
}

function render(status: RequestStatus): ToolResult {
  const header = mdFields({
    handle: status.handle,
    state: status.state,
    lead_id: status.lead.id,
    platform: status.lead.platform,
    lead_status: status.lead.status,
    request_key: status.request.request_key,
    instructions: status.request.instructions,
    human_review_required: status.request.force_human_review,
  });
  const drafts = status.drafts.length
    ? status.drafts
        .map((d) =>
          [
            `#### ${d.kind} — ${d.a_status} (approval_id: ${d.a_id})`,
            reviewLine(d),
            d.body ?? "_no body_",
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n")
    : "_no requested reply draft yet_";
  const source = sourceLine(status.lead);
  return text(
    `## Reply request (${status.orgName})\n${header}\n\n### Source\n${source || "_no saved source context_"}\n\n### Drafts (${status.drafts.length})\n${drafts}`,
  );
}

async function readStatus(
  ctx: NoelleContext,
  orgName: string,
  orgId: string,
  leadId: string,
  requestKey?: string,
  knownLead?: LeadRow,
): Promise<RequestStatus> {
  const [lead] = knownLead ? [knownLead] : await ctx.sql<LeadRow[]>`
    select id, platform, status, author_handle, payload
    from noelle.leads where id = ${leadId} and org_id = ${orgId}`;
  if (!lead) throw new NoelleError(`Lead ${leadId} not found in this org.`);
  const currentRequest = storedRequest(payloadOf(lead));
  const currentKey = typeof currentRequest.request_key === "string" ? currentRequest.request_key : leadId;
  const key = requestKey ?? currentKey;
  if (key.length > 200) throw new NoelleError("requestKey must be 200 characters or fewer.");
  const request = key === currentKey ? currentRequest : { request_key: key };
  const drafts = await ctx.sql<DraftRow[]>`
    select a.id a_id, a.status a_status, coalesce(d.payload->>'kind','reply') as kind,
      coalesce(d.payload->>'edited_body', d.payload->>'body') as body,
      d.payload->'verifier_meta'->>'pass' as review_pass,
      d.payload->'verifier_meta'->'reasons' as review_reasons,
      d.payload->'verifier_meta'->>'attempts' as review_attempts
    from noelle.approvals a join noelle.drafts d on d.id = a.draft_id
    where a.lead_id = ${leadId} and a.org_id = ${orgId}
      and coalesce(d.payload->>'kind','reply') <> 'dm'
      and d.payload->>'reply_request_key' = ${key}
    order by a.created_at asc`;
  const reviewValues = drafts.map(reviewValue);
  const state = drafts.length
    ? reviewValues.some((value) => value === null)
      ? "review_pending"
      : reviewValues.every(Boolean)
        ? "completed"
        : "needs_review"
    : key !== currentKey
      ? "request_not_found"
      : lead.status === "drafting" || lead.status === "errored" || lead.status === "skipped"
      ? lead.status
      : "queued_for_drafting";
  return { orgName, handle: `${leadId}:${key}`, state, lead, request, drafts };
}

export async function requestReply(
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult> {
  ctx.assertWritable("request a reply draft for a lead");
  const org = await ctx.resolveOrg(optStr(args, "org"));
  const leadId = reqStr(args, "leadId");
  const requestedPlatform = optStr(args, "platform");
  const requestKey = readRequestKey(args, leadId);
  const waitSeconds = readWaitSeconds(args);
  const instructions = optStr(args, "instructions") ?? null;
  const [lead] = await ctx.sql<LeadRow[]>`
    select id, platform, status, author_handle, payload
    from noelle.leads where id = ${leadId} and org_id = ${org.orgId}`;
  if (!lead) throw new NoelleError(`Lead ${leadId} not found in this org.`);
  const platform = assertReplyPlatform(lead.platform ?? undefined);
  if (requestedPlatform && requestedPlatform !== platform) {
    throw new NoelleError(`Lead ${leadId} is ${platform}, not ${requestedPlatform}.`);
  }
  const existing = storedRequest(payloadOf(lead));
  // A retry can refer to a completed version older than the lead's latest request.
  // Read its saved approvals before changing the lead or rejecting a newer request.
  if (typeof existing.request_key === "string" && existing.request_key !== requestKey) {
    const previous = await readStatus(ctx, org.name, org.orgId, leadId, requestKey, lead);
    if (previous.drafts.length > 0) return render(previous);
  }
  const inFlight = payloadOf(lead).reply_requested === true &&
    ["classified", "drafting"].includes(lead.status ?? "");
  if (inFlight && existing.request_key !== requestKey) {
    throw new NoelleError(
      `Lead ${leadId} already has an in-flight reply request (${String(existing.request_key ?? "unknown")}). Read it or wait for it to finish before requesting another.`,
    );
  }
  if (existing.request_key !== requestKey) {
    if (["drafting", "classifying"].includes(lead.status ?? "")) {
      throw new NoelleError(`Lead ${leadId} is already being processed. Wait for it to finish before requesting another reply.`);
    }
    const marker = {

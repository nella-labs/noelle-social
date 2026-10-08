import { createHash } from "node:crypto";
import { OutboundFactualContextSchema, type OutboundFactualContext } from "@noelle/contracts";
import {
  callAgentModel,
  resolveWorkerRouting,
  verifyDrafts,
  type CallAgentModelDeps,
  type DraftToVerify,
  type DraftVerdict,
  type JevRun,
  type ModelRouting,
  type PersistedModelOverrides,
  type VerifyContext,
} from "@noelle/runtime";

import { PENDING_REPLY_PAGE_SIZE, type PendingReplyCursor } from "./pending-reply-pagination.js";

const RECHECK_VERSION = 2;
// Mirrors both interns' judgeRouting(). X uses this only with VERIFY_CHEAP.
const HAIKU_JUDGE: ModelRouting = {
  primary: { engine: "bedrock", model: "claude-haiku-4-5" },
};

type JsonObject = Record<string, unknown>;

export interface PendingReplyCandidate {
  approvalId: string;
  approvalCreatedAt: string;
  leadExternalId: string | null;
  authorHandle?: string | null;
  authorId?: string | null;
  draftId: string;
  leadId: string;
  orgId: string;
  agentInstanceId: string;
  platform: "linkedin" | "x";
  modelOverrides: PersistedModelOverrides | null;
  draftPayload: JsonObject;
  leadPayload: JsonObject;
  priorRepliesToPerson?: string[];
  recentReplies?: string[];
}

export interface ReplyRecheckMarker {
  version: typeof RECHECK_VERSION;
  bodySha256: string;
  contextSha256: string;
  outcome: "passed" | "rejected";
  checkedAt: string;
}

export interface ReplyReviewMeta {
  pass: boolean;
  judgeOk: boolean;
  judgeProvider: NonNullable<DraftVerdict["judgeProvider"]>;
  scores: DraftVerdict["scores"];
  reasons: string[];
  attempts: number;
}

export interface PendingReplyStore {
  list(orgId: string, after?: PendingReplyCursor, through?: Date): Promise<PendingReplyCandidate[]>;
  replyHistory?(candidate: PendingReplyCandidate): Promise<{ priorRepliesToPerson: string[]; recentReplies: string[] }>;
  save(candidate: PendingReplyCandidate, body: string, meta: ReplyReviewMeta, marker: ReplyRecheckMarker): Promise<boolean>;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
}

function anchorSnippets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return entry.trim() ? [entry.trim()] : [];
    if (!entry || typeof entry !== "object") return [];
    const snippet = nonempty((entry as JsonObject).snippet);
    return snippet ? [snippet] : [];
  }).slice(0, 8);
}

function effectiveBody(payload: JsonObject): string | null {
  // The approval screen and actuator both prefer edited_body whenever it is
  // present. Do not silently fall back to the generated body for an empty edit.
  const body = payload.edited_body ?? payload.body;
  return typeof body === "string" && body.trim() ? body : null;
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function savedCaption(payload: JsonObject): string | null {
  return nonempty(payload.image_caption) ?? nonempty(payload.imageCaption);
}

function hasUncaptionedMedia(payload: JsonObject, caption: string | null | undefined): boolean {
  const media = payload.images ?? payload.image_urls ?? payload.imageUrls;
  return Array.isArray(media) && media.length > 0 && !nonempty(caption);
}

function savedFactualContext(row: PendingReplyCandidate): OutboundFactualContext | null {
  const captured = Object.hasOwn(row.draftPayload, "review_context");
  const input = captured ? row.draftPayload.review_context : {
    version: 1,
    platform: row.platform,
    postText: nonempty(row.leadPayload.original_post_text) ?? nonempty(row.leadPayload.text),
    authorHandle: nonempty(row.leadPayload.author_handle) ?? row.authorHandle ?? null,
    knowledgeAnchors: stringArray(row.leadPayload.knowledge_anchors),
    personProfile: nonempty(row.leadPayload.authorHeadline),
    ...(savedCaption(row.leadPayload) ? { imageCaption: savedCaption(row.leadPayload) } : {}),
    ...(row.platform === "x" && row.leadPayload.conversation != null
      ? { conversation: row.leadPayload.conversation } : {}),
  };
  const parsed = OutboundFactualContextSchema.safeParse(input);
  return parsed.success && parsed.data.platform === row.platform ? parsed.data : null;
}

function alreadyReviewed(payload: JsonObject, hash: string, contextHash?: string): boolean {
  const marker = payload.reply_recheck;
  const meta = payload.verifier_meta;
  if (!meta || typeof meta !== "object") return false;
  const verdict = meta as JsonObject;
  // The recovery lane only revisits failed/absent reviews. A new writer may
  // have produced a passing review while this command is running.
  if (verdict.pass === true && verdict.judgeOk === true) return true;
  if (!marker || typeof marker !== "object") return false;
  const m = marker as JsonObject;
  return contextHash !== undefined && m.version === RECHECK_VERSION && m.bodySha256 === hash
    && m.contextSha256 === contextHash && verdict.judgeOk === true;
}

export interface RecheckCounts {
  selected: number;
  reviewed: number;
  passed: number;
  rejected: number;
  unavailable: number;
  alreadyReviewed: number;
  skippedMedia: number;
  skippedHuman: number;
  skippedContext: number;
  stale: number;
}

export async function recheckPendingReplies(args: {
  orgId: string;
  store: PendingReplyStore;
  review: (input: { candidate: PendingReplyCandidate; draft: DraftToVerify; context: VerifyContext }) => Promise<DraftVerdict>;
  maxReviews?: number;
  now?: () => Date;
}): Promise<RecheckCounts> {
  const counts: RecheckCounts = {
    selected: 0, reviewed: 0, passed: 0, rejected: 0, unavailable: 0,
    alreadyReviewed: 0, skippedMedia: 0, skippedHuman: 0, skippedContext: 0, stale: 0,
  };
  const maxReviews = Number.isFinite(args.maxReviews ?? 100)
    ? Math.max(0, Math.min(Math.floor(args.maxReviews ?? 100), 1_000)) : 100;
  if (maxReviews === 0) return counts;
  let attempted = 0;
  const through = (args.now ?? (() => new Date()))();
  let after: PendingReplyCursor | undefined;
  while (attempted < maxReviews) {
    const rows = await args.store.list(args.orgId, after, through);
    if (!rows.length) break;
    for (const row of rows) {
      if (attempted >= maxReviews) break;
      // Defense in depth: the SQL store is tenant-scoped; an injected store must
      // never cause the wrong tenant's approval to be reviewed or mutated.
      if (row.orgId !== args.orgId) continue;
      counts.selected++;
      if (row.draftPayload.human_review_required === true) { counts.skippedHuman++; continue; }
      const body = effectiveBody(row.draftPayload);
      if (!body) { counts.skippedContext++; continue; }
      const hash = bodyHash(body);
      if (alreadyReviewed(row.draftPayload, hash)) { counts.alreadyReviewed++; continue; }
      const facts = savedFactualContext(row);
      if (!facts || !nonempty(facts.postText)) { counts.skippedContext++; continue; }
      if (hasUncaptionedMedia(row.leadPayload, facts.imageCaption)) { counts.skippedMedia++; continue; }
      const contextHash = bodyHash(JSON.stringify(facts));
      if (alreadyReviewed(row.draftPayload, hash, contextHash)) { counts.alreadyReviewed++; continue; }

      const light = row.leadPayload.reply_kind === "light" || row.leadPayload.post_kind === "light";
      const draft: DraftToVerify = { kind: "reply", angle: nonempty(row.draftPayload.angle), body };
      const history = await args.store.replyHistory?.(row).catch(() => ({ priorRepliesToPerson: [], recentReplies: [] }));
      const context: VerifyContext = {
        platform: row.platform,
        postText: facts.postText,
        ...(facts.authorHandle !== undefined ? { authorHandle: facts.authorHandle } : {}),
        voiceAnchors: anchorSnippets(row.leadPayload.anchors),
        knowledgeAnchors: facts.knowledgeAnchors,
        ...(facts.operatorFacts !== undefined ? { operatorFacts: facts.operatorFacts } : {}),
        ...(facts.conversation !== undefined ? { conversation: facts.conversation } : {}),
        ...(facts.personProfile !== undefined ? { personProfile: facts.personProfile } : {}),
        priorRepliesToPerson: row.priorRepliesToPerson ?? history?.priorRepliesToPerson ?? [],
        recentReplies: row.recentReplies ?? history?.recentReplies ?? [],
        ...(row.platform === "x" ? { charLimit: 250 } : {}),
        ...(light ? { allowCelebration: true } : {}),
        ...(facts.imageCaption !== undefined ? { imageCaption: facts.imageCaption } : {}),
      };
      let verdict: DraftVerdict;
      attempted++;
      try {
        verdict = await args.review({ candidate: row, draft, context });
      } catch {
        counts.unavailable++;
        continue;
      }
      // verifyDrafts can fail open for the human queue. That synthetic result
      // cannot authorize unattended sending, nor suppress a later retry.
      if (verdict.judgeOk !== true || !verdict.judgeProvider || verdict.judgeProvider === "none") {
        counts.unavailable++;
        continue;
      }
      const meta: ReplyReviewMeta = {
        pass: verdict.pass === true,
        judgeOk: true,
        judgeProvider: verdict.judgeProvider,
        scores: verdict.scores,
        reasons: verdict.reasons.slice(0, 8),
        attempts: 0,
      };
      const marker: ReplyRecheckMarker = {
        version: RECHECK_VERSION,
        bodySha256: hash,
        contextSha256: contextHash,
        outcome: meta.pass ? "passed" : "rejected",
        checkedAt: (args.now ?? (() => new Date()))().toISOString(),
      };
      if (!await args.store.save(row, body, meta, marker)) {
        counts.stale++;
        continue;
      }
      counts.reviewed++;
      if (meta.pass) counts.passed++;
      else counts.rejected++;
    }
    const last = rows[rows.length - 1]!;
    if (after && last.approvalCreatedAt === after.approvalCreatedAt && last.approvalId === after.approvalId) {
      throw new Error("Reply recheck cursor did not advance");
    }
    after = { approvalCreatedAt: last.approvalCreatedAt, approvalId: last.approvalId };
    if (rows.length < PENDING_REPLY_PAGE_SIZE) break;
  }
  return counts;
}

/** Recheck uses the same judge route as each deployed writer. */
export function configuredReplyJudgeRouting(
  candidate: PendingReplyCandidate,
  cheapX = process.env.NOELLE_DRAFTER_VERIFY_CHEAP === "1" ||
    process.env.NOELLE_DRAFTER_VERIFY_CHEAP?.toLowerCase() === "true",
): ModelRouting {
  if (candidate.platform === "linkedin" || cheapX) return HAIKU_JUDGE;
  const routing = resolveWorkerRouting("drafter", candidate.modelOverrides);
  if (!routing) throw new Error("X drafter routing is unavailable");
  return routing;
}

/** Jev remains primary; uncertainty goes through the writer's runtime route. */
export function createConfiguredPendingReplyReviewer(opts: {
  depsForPlatform: (platform: PendingReplyCandidate["platform"]) => CallAgentModelDeps;
  callAgentModel?: typeof callAgentModel;
  jevRun?: JevRun;
  cheapX?: boolean;
}): (input: { candidate: PendingReplyCandidate; draft: DraftToVerify; context: VerifyContext }) => Promise<DraftVerdict> {
  const call = opts.callAgentModel ?? callAgentModel;
  return ({ candidate, draft, context }) => verifyDrafts(
    [draft], context,
    async (system, prompt) => {
      const result = await call({
        bucket: "drafter-verify",
        routing: configuredReplyJudgeRouting(candidate, opts.cheapX),
        orgId: candidate.orgId,
        instanceId: candidate.agentInstanceId,
        worker: "drafter",
        agentRole: candidate.platform === "linkedin" ? "linkedin_intern" : "x_intern",
        system,
        prompt,
      }, opts.depsForPlatform(candidate.platform));
      return result.text;
    },
    opts.jevRun ? { jevRun: opts.jevRun } : undefined,
  );
}

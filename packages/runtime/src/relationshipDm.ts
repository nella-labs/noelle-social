import { randomUUID } from "node:crypto";
import type { OutboundIn } from "@noelle/contracts";
import type { Sql } from "postgres";
import type { ModelRouting } from "./types.js";
import { evaluateJevBooleans, type JevRun } from "./jev.js";
import { claimRelationshipDmCandidates, markRelationshipDmResult } from "./relationshipDmDb.js";
import {
  RELATIONSHIP_DM_JUDGE, RELATIONSHIP_DM_SYSTEM, parseRelationshipDm,
  hasRecentRelationshipPost, relationshipDmPrompt, relationshipDmVerdict,
  usableRelationshipEvidence,
} from "./relationshipDmPolicy.js";
import type { RelationshipDmCandidate, RelationshipDmPlatform, RelationshipDmRunner } from "./relationshipDmTypes.js";

export * from "./relationshipDmTypes.js";
export { hasPendingRelationshipDmRequests } from "./relationshipDmDb.js";

export interface RelationshipDmTickArgs {
  sql: Sql;
  orgId: string;
  instanceId: string;
  platform: RelationshipDmPlatform;
  includeRecurring?: boolean;
  runner: RelationshipDmRunner;
  routing: ModelRouting;
  postOutbound: (body: OutboundIn) => Promise<unknown>;
  log: { info(meta: object, message: string): void; error(meta: object, message: string): void };
  jevRun?: JevRun;
}

/** The injected storage boundary lets tests exercise the real generation/queue flow. */
export interface RelationshipDmStorage {
  claim: typeof claimRelationshipDmCandidates;
  finish: typeof markRelationshipDmResult;
}

async function generate(args: RelationshipDmTickArgs, person: RelationshipDmCandidate, allowQuestion: boolean) {
  const prompt = relationshipDmPrompt(person, allowQuestion);
  const call = (system: string, input: string) => args.runner.draft({
    bucket: "drafter-codex", routing: args.routing, orgId: args.orgId,
    instanceId: args.instanceId, worker: "drafter",
    agentRole: args.platform === "linkedin" ? "linkedin_intern" : "x_intern",
    system, prompt: input,
  });
  let reason = "";
  let judgeVerdict: { pass: boolean; reason: string; judgeProvider: "jev" | "legacy" | "none"; judgeOk: boolean } | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await call(RELATIONSHIP_DM_SYSTEM, `${prompt}${reason ? `\nPrevious attempt rejected: ${reason}. Use only the evidence, or skip.` : ""}`);
    // An explicit skip ends the attempt without spending another model call.
    try { if (typeof JSON.parse(result.text)?.skip === "string") return { draft: null }; } catch { /* validation below */ }
    const draft = parseRelationshipDm(result.text, person, allowQuestion);
    if ("error" in draft) { reason = draft.error; continue; }
    const state = { sourceContext: JSON.parse(prompt), draft: draft.body };
    const jev = await evaluateJevBooleans({
      state,
      questions: {
        grounded: { instructions: "Is every factual and relationship claim in this friendly DM supported by the saved primary evidence?" },
        specific: { instructions: "Does the DM react naturally to a specific saved detail instead of generic praise or critique of the person's writing?" },
        pressureFree: { instructions: "Does this DM avoid pitches, recruiting, meeting requests, fake intimacy, and questions disallowed by the assigned mode?" },
      },
      ...(args.jevRun ? { run: args.jevRun } : {}),
    });
    let verdict: NonNullable<typeof judgeVerdict>;
    if (Object.values(jev).every((answer) => answer.kind === "confident")) {
      const failures = Object.entries(jev).filter(([, answer]) => answer.kind === "confident" && !answer.pass).map(([name]) => name);
      verdict = { pass: failures.length === 0, reason: failures.length ? `Failed Jev ${failures.join(", ")} check` : "Passed Jev evidence and pressure checks", judgeProvider: "jev", judgeOk: true };
    } else {
      const checked = await call(RELATIONSHIP_DM_JUDGE, JSON.stringify(state));
      const legacy = relationshipDmVerdict(checked.text);
      const judgeOk = legacy.reason !== "Invalid verification result";
      verdict = { ...legacy, judgeProvider: judgeOk ? "legacy" : "none", judgeOk };
    }
    if (verdict.pass) return { draft, verdict, attempts: attempt };
    judgeVerdict = verdict;
    reason = verdict.reason;
  }
  return { draft: null, verdict: judgeVerdict };
}

/** Stored-data only: no discovery, enrichment, retrieval service, or send dependency. */
export async function runRelationshipDmTick(
  args: RelationshipDmTickArgs,
  storage: RelationshipDmStorage = { claim: claimRelationshipDmCandidates, finish: markRelationshipDmResult },
): Promise<number> {
  const people = await storage.claim(args.sql, {
    orgId: args.orgId,
    instanceId: args.instanceId,
    platform: args.platform,
    limit: 5,
    includeRecurring: args.includeRecurring ?? true,
  });
  let queued = 0;
  for (const [index, person] of people.entries()) {
    const finish = (
      status: "queued" | "skipped" | "failed",
      reason?: string,
      judgeVerdict?: { pass: boolean; reason: string; judgeProvider: "jev" | "legacy" | "none"; judgeOk: boolean },
    ) => storage.finish(args.sql, {
      orgId: args.orgId, reservationId: person.reservationId, status, reason, judgeVerdict,
    });
    try {
      if (!hasRecentRelationshipPost(person)) {
        await finish("skipped", "No saved post from the last 7 days");
        continue;
      }
      const evidence = usableRelationshipEvidence(person);
      if (!evidence.some((e) => e.kind !== "profile")) {
        await finish("skipped", "No specific saved primary evidence");
        continue;
      }
      // At least three successfully queued no-question notes before an optional
      // question. Small batches stay no-ask; a failed note cannot skew the mix.
      const draft = await generate(args, person, queued >= 3 && index % 5 === 4);
      if (!draft.draft) {
        await finish("skipped", "No grounded, pressure-free draft passed verification", draft.verdict);
        continue;
      }
      const sourceText = draft.draft.evidence.map((e) =>
        `${e.kind}${e.occurredAt ? ` (${e.occurredAt})` : ""}: ${e.text}${e.url ? `\n${e.url}` : ""}`,
      ).join("\n\n");
      const id = `relationship-dm:${person.reservationId}`;
      const outbound: OutboundIn = {
        owner: { orgId: args.orgId, agentInstanceId: args.instanceId },
        leadId: id, batchNumber: null, platform: args.platform,
        authorHandle: person.authorHandle, authorId: person.authorId,
        authorFollowers: null, allowsDms: null, originalPostId: id,
        originalPostText: `Friendly DM from saved context\n\n${sourceText}`,
        originalPostUrl: person.profileUrl, postedAt: new Date().toISOString(),
        matchedTrigger: "stored-person-context", postKind: "relationship_dm", tier: null,
        drafts: [{
          id: randomUUID(), kind: "dm", angle: null, body: draft.draft.body, charCount: [...draft.draft.body].length,
          dmVoiceCheck: { pass: true, attempts: draft.attempts ?? 0, reasons: [] },
        }],
        anchors: draft.draft.evidence.map((e) => ({ snippet: `${e.kind}: ${e.text}`, score: 1 })),
      };
      await args.postOutbound(outbound);
      await finish("queued", undefined, draft.verdict);
      queued++;
      args.log.info({ platform: args.platform, reservationId: person.reservationId }, "friendly DM queued for review");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      args.log.error({ platform: args.platform, reservationId: person.reservationId, reason }, "friendly DM failed");
      // If bookkeeping also fails, keep the reservation intact and report it.
      // Never release an uncertain outbound write and risk a second first DM.
      await finish("failed", reason).catch((statusError: unknown) => {
        args.log.error({ reservationId: person.reservationId, statusError }, "friendly DM status update failed");
      });
    }
  }
  return queued;
}

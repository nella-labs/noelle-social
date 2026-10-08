import { z } from "zod";
import type { Sql } from "postgres";
import type { ActiveInstance } from "../lib/activation.js";
import type { Logger } from "../lib/logger.js";
import type { VideoBriefer } from "../lib/brief-generate.js";
import { isBudgetAdmissionError } from "@noelle/runtime";
import { createVideoModelOperation, videoOperationFailureReason } from "../lib/video-gemini.js";
import { renderBriefMarkdown, countForgeFollowups, countWords } from "../lib/brief-generate.js";
import { loadBrandContext, type VaultKb } from "../lib/vault-grounding.js";
import {
  claimReadyDraftsForBrief,
  insertRecordingBrief,
  revertBriefClaim,
  markBriefClaimOutcome,
  listHeldBriefClaims,
  markBriefDispatched,
  type BriefFailureReason,
  type HeldBriefClaim,
} from "../lib/recording-briefs-db.js";

export interface BrieferTickDeps {
  sql: Sql;
  log: Logger;
  instance: ActiveInstance;
  briefer: VideoBriefer;
  batchLimit: number;
  model: string;
  /** Provenance stamp for the generated briefs (claude | bedrock | vertex). */
  sourceEngine: string;
  /** Vault KB for brand/voice grounding (null = no vault → skipped). */
  kb?: VaultKb | null;
}

// A runtime hint (seconds) = the largest beat end time in the draft's timed
// structure. Guarded parse of the jsonb: a non-array or a beat missing a numeric
// tEnd yields no hint (the model then infers a sensible target for the platform).
const StructureHintSchema = z.array(z.object({ tEnd: z.number().nonnegative() }).passthrough());
function runtimeHintFromStructure(structure: unknown): number | null {
  const parsed = StructureHintSchema.safeParse(structure);
  if (!parsed.success || parsed.data.length === 0) return null;
  const max = Math.max(...parsed.data.map((b) => b.tEnd));
  return max > 0 ? max : null;
}

export class BriefingOutcomeError extends Error {
  constructor(readonly reason: BriefFailureReason | "generation_in_progress" | "preparation_failed", readonly rowsProcessed: number) {
    super(`Recording brief requires recovery: ${reason}`);
    this.name = "BriefingOutcomeError";
  }
}

/** Durable admission precedes generation; only acknowledged finalizations count. */
export async function runBrieferTick(deps: BrieferTickDeps): Promise<number> {
  const { sql, log, instance, briefer } = deps;
  const claimed = await claimReadyDraftsForBrief(sql, instance.id, deps.batchLimit, instance.org_id,
    { sourceEngine: deps.sourceEngine, model: deps.model });
  let n = 0;
  let failed: BriefingOutcomeError["reason"] | undefined;
  for (const [index, draft] of claimed.entries()) {
    let generatorEntered = false;
    let blocked = false;
    let generated = false;
    let stored = false;
    let reason: BriefFailureReason | "preparation_failed" = "preparation_failed";
    const operation = createVideoModelOperation(async () => {
      reason = "dispatch_uncertain";
      return await markBriefDispatched(sql, draft) ? "dispatch" : "not_dispatched";
    });
    try {
      const brandContext = await loadBrandContext(deps.kb ?? null, draft.hook || instance.objective);
      const runtimeHintSec = runtimeHintFromStructure(draft.structure);
      generatorEntered = true;
      reason = "generation_unknown";
      const out = await briefer.brief({
        hook: draft.hook, concept: draft.concept, script: draft.script,
        platform: draft.platform, brandContext, runtimeHintSec, operation,
      });
      generated = true;
      if (operation.acknowledgement !== "dispatch") {
        reason = videoOperationFailureReason(operation);
      } else if (!out) reason = "generation_unknown";
      else {
        reason = "completion_failed";
        const briefMd = renderBriefMarkdown(out);
        const forgeFollowups = countForgeFollowups(out);
        const id = await insertRecordingBrief(sql, {
          claim: draft, runtimeTarget: out.runtimeTarget > 0 ? Math.round(out.runtimeTarget) : null,
          brief: out, briefMd, forgeFollowups, sourceEngine: deps.sourceEngine, model: deps.model,
        });
        if (id) {
          stored = true;
          n++;
          log.info({ draft: draft.draft_id, forgeFollowups, words: countWords(briefMd) }, "recording brief written");
          continue;
        }
        reason = "source_changed";
      }
    } catch (error) {
      blocked = isBudgetAdmissionError(error);
      if (operation.acknowledgement === "dispatch") reason = generated ? "completion_failed" : "generation_failed";
      else reason = !generatorEntered ? "preparation_failed" : videoOperationFailureReason(operation, blocked);
      if (blocked) log.warn({ draft: draft.draft_id, err: (error as Error).message }, "brief model admission stopped");
    }
    failed ??= reason;
    if (!stored) {
      try {
        const recorded = reason === "preparation_failed" ? await revertBriefClaim(sql, draft)
          : await markBriefClaimOutcome(sql, draft, reason);
        if (!recorded) log.warn({ draft: draft.draft_id }, "brief claim outcome was not acknowledged");
      } catch {
        log.warn({ draft: draft.draft_id }, "brief claim outcome could not be recorded");
      }
    }
    log.warn({ draft: draft.draft_id, reason }, "recording brief requires recovery");
    if (blocked) {
      for (const untouched of claimed.slice(index + 1)) {
        try { if (!await revertBriefClaim(sql, untouched)) log.warn({ draft: untouched.draft_id }, "unstarted brief release was not acknowledged"); }
        catch { log.warn({ draft: untouched.draft_id }, "unstarted brief release could not be recorded"); }
      }
      break;
    }
  }
  let held: HeldBriefClaim[];
  try { held = await listHeldBriefClaims(sql, instance.id, instance.org_id); }
  catch { throw new BriefingOutcomeError(failed ?? "completion_failed", n); }
  const reason = failed ?? held[0]?.reason;
  if (reason) throw new BriefingOutcomeError(reason, n);
  return n;
}

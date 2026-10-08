import type { Sql } from "postgres";
import { readSourceNonnegativeNumber } from "@noelle/runtime/source-values";
import { isBudgetAdmissionError } from "@noelle/runtime";
import { createVideoModelOperation, videoOperationFailureReason } from "../lib/video-gemini.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractVideo } from "@noelle/video-extract";
import type { ActiveInstance } from "../lib/activation.js";
import type { Logger } from "../lib/logger.js";
import type { VideoAnalyzer } from "../lib/teardown-analyze.js";
import { claimClipsForTeardown, markTeardownDispatched, completeTeardownClaim, markTeardownClaimOutcome,
  listVideoGenerationHolds, type TeardownFailureReason } from "../lib/teardown-db.js";

export interface TeardownTickDeps {
  sql: Sql;
  log: Logger;
  instance: ActiveInstance;
  bulkAnalyzer: VideoAnalyzer;
  deepAnalyzer: VideoAnalyzer;
  batchLimit: number;
  dailyCap: number;
  whisperModel?: string;
}

export class TeardownOutcomeError extends Error {
  constructor(readonly reason: TeardownFailureReason | "generation_in_progress", readonly rowsProcessed: number) {
    super(`Video teardown requires recovery: ${reason}`);
    this.name = "TeardownOutcomeError";
  }
}

/** Durable admission precedes extraction; paid dispatch and completion each require an exact acknowledgement. */
export async function runTeardownTick(deps: TeardownTickDeps): Promise<number> {
  const { sql, log, instance } = deps;
  const clips = await claimClipsForTeardown(sql, { instanceId: instance.id, orgId: instance.org_id,
    limit: deps.batchLimit, dailyCap: deps.dailyCap });
  let n = 0;
  let failed: TeardownFailureReason | undefined;
  for (const [index, c] of clips.entries()) {
    let workDir: string | undefined;
    let generatorEntered = false;
    let blocked = false;
    let generated = false;
    let stored = false;
    let reason: TeardownFailureReason = "extraction_failed";
    const operation = createVideoModelOperation(async () => {
      reason = "dispatch_uncertain";
      return await markTeardownDispatched(sql, c) ? "dispatch" : "not_dispatched";
    });
    try {
      workDir = await mkdtemp(join(tmpdir(), "nova-td-"));
      const ex = await extractVideo({
        videoUrl: c.video_url ?? "",
        postUrl: c.url,
        workDir,
        maxFrames: 6,
        ...(deps.whisperModel ? { whisperModel: deps.whisperModel } : {}),
        log,
      });
      generatorEntered = true;
      reason = "generation_unknown";
      const analyzer = c.deep_tier ? deps.deepAnalyzer : deps.bulkAnalyzer;
      const teardown = await analyzer.analyze({
        operation,
        caption: c.caption,
        transcript: ex.transcript,
        keyframePaths: ex.keyframePaths,
        cutTimestamps: ex.cutTimestamps,
        metrics: {
          views: c.views,
          likes: c.likes,
          comments: c.comments,
          shares: c.shares,
          durationS: readSourceNonnegativeNumber(ex.durationS, c.duration_s),
        },
      });
      generated = true;
      if (operation.acknowledgement !== "dispatch") {
        reason = videoOperationFailureReason(operation);
        throw new Error("Teardown dispatch was not acknowledged");
      }
      if (!teardown) {
        reason = "generation_unknown";
        throw new Error("Teardown generation outcome is unknown");
      }
      reason = "completion_failed";
      const acknowledged = await completeTeardownClaim(sql, {
        claim: c,
        teardown,
        transcript: ex.transcript || null,
        tier: c.deep_tier ? "deep" : "bulk",
        model: c.deep_tier ? "gemini-2.5-pro" : "gemini-2.5-flash",
      });
      if (!acknowledged) {
        reason = "source_changed";
        throw new Error("Teardown source changed before completion");
      }
      stored = true;
      n += 1;
      log.info({ clip: c.id, handle: c.author_handle, tier: c.deep_tier ? "deep" : "bulk" }, "teardown written");
    } catch (error) {
      blocked = isBudgetAdmissionError(error);
      if (operation.acknowledgement === "dispatch" && !generated) reason = "generation_failed";
      else if (operation.acknowledgement !== "dispatch" && generatorEntered) {
        reason = videoOperationFailureReason(operation, blocked);
      }
      if (blocked) log.warn({ clip: c.id, err: (error as Error).message }, "teardown model admission stopped");
      failed ??= reason;
      if (!stored) {
        try {
          const status = reason === "extraction_failed" || reason === "preparation_failed" ? "released"
            : reason === "generation_unknown" || reason === "dispatch_uncertain" ? "unknown" : "failed";
          if (!await markTeardownClaimOutcome(sql, c, status, reason)) log.warn({ clip: c.id }, "teardown outcome was not acknowledged");
        } catch { log.warn({ clip: c.id }, "teardown outcome could not be recorded"); }
      }
      log.warn({ clip: c.id, reason }, "teardown requires recovery");
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    if (blocked) {
      for (const untouched of clips.slice(index + 1)) {
        try { if (!await markTeardownClaimOutcome(sql, untouched, "released", "preparation_failed")) log.warn({ clip: untouched.id }, "unstarted teardown release was not acknowledged"); }
        catch { log.warn({ clip: untouched.id }, "unstarted teardown release could not be recorded"); }
      }
      break;
    }
  }
  let held;
  try { held = await listVideoGenerationHolds(sql, { instanceId: instance.id, orgId: instance.org_id, kind: "teardown", limit: 8 }); }
  catch { throw new TeardownOutcomeError(failed ?? "completion_failed", n); }
  const reason = failed ?? held.holds[0]?.reason;
  if (reason) throw new TeardownOutcomeError(reason as TeardownFailureReason | "generation_in_progress", n);
  return n;
}

import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { createSecretsClient, APIFY_TOKEN_SECRET_ID } from "../lib/secrets.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createApifyResolver } from "../lib/apify-resolver.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { listInstancesWithPendingHarvest, markHarvestRunComplete } from "../lib/activation.js";
import { recordRun } from "../lib/worker-runs.js";
import { runHarvesterTick, HarvestOutcomeError } from "./harvester-tick.js";
import { runSelfTrackTick } from "./self-track-tick.js";
import { createTextJsonFn } from "../lib/text-backend.js";

// Nova's "Scout" harvester. Cost-gated MANUAL run (mirrors the LinkedIn account
// feeder): it polls for instances whose harvest was requested
// (video_feeder_run_requested_at) and no-ops otherwise, so it's cheap to leave
// running. Each run pulls the watchlist creators + niches via Apify, applies the
// W1 filters, and upserts into noelle.video_clips. Draft-only, read-only Apify.
async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ kind: "harvester", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });
  const recorder = createPgSpendRecorder(sql);
  const resolveApify = createApifyResolver({
    sql,
    secrets,
    apifyTokenSecretId: APIFY_TOKEN_SECRET_ID,
    ...(env.INSTAGRAM_ACTOR_ID ? { instagramActorId: env.INSTAGRAM_ACTOR_ID } : {}),
    ...(env.TIKTOK_ACTOR_ID ? { tiktokActorId: env.TIKTOK_ACTOR_ID } : {}),
    log,
  });

  // Objective grader (off by default). Routes through the reliable text seam
  // (claude-cli / Bedrock, Gemini fallback) — the Vega-style relevance pass must
  // not silently fail-open on Lima, where Gemini text calls flake. Absent ⇒ niche
  // lanes upsert ungraded.
  const grader = env.NOELLE_NOVA_OBJECTIVE_GRADE
    ? createTextJsonFn(env, { sql, worker: "harvester" })
    : undefined;

  const boot = await runBootChecks({
    log,
    checks: [{ name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } }],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  const shouldStop = installShutdown(log);

  // 24/7 own-account tracking — a periodic sweep alongside the manual harvest
  // loop. Each fire re-pulls is_own sources due for a refresh and snapshots
  // their post performance (independent of the manual harvest flag). A guard
  // prevents overlapping sweeps; a slow Apify pull just defers the next fire.
  if (env.NOELLE_VIDEO_SELF_TRACK) {
    let sweeping = false;
    const sweep = async () => {
      if (sweeping || shouldStop()) return;
      sweeping = true;
      try {
        const n = await runSelfTrackTick({
          sql,
          log,
          resolveApify,
          recorder,
          dueBefore: new Date(Date.now() - env.NOELLE_VIDEO_SELF_TRACK_MS),
          maxPosts: env.NOELLE_VIDEO_SELF_TRACK_POSTS,
          windowDays: env.NOELLE_VIDEO_SELF_TRACK_WINDOW_DAYS,
        });
        if (n > 0) log.info({ snapshots: n }, "self-track sweep complete");
      } catch (err) {
        log.error({ err: (err as Error).message }, "self-track sweep failed");
      } finally {
        sweeping = false;
      }
    };
    void sweep(); // prime on boot so the first snapshot isn't an interval away
    const timer = setInterval(() => void sweep(), env.NOELLE_VIDEO_SELF_TRACK_MS);
    if (typeof timer.unref === "function") timer.unref();
    log.info({ everyMs: env.NOELLE_VIDEO_SELF_TRACK_MS }, "own-account tracking enabled");
  }

  log.info({}, "video harvester (Scout) up — polling for requested harvest runs");
  await runWorkerLoop({
    log,
    kind: "harvester",
    pollMs: env.DISCOVERY_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listInstancesWithPendingHarvest(sql),
    onTick: async (inst) => {
      const run = await recordRun({ sql, kind: "harvester", instanceId: inst.id });
      let total = 0;
      try {
        total = await runHarvesterTick({ sql, log, instance: inst, resolveApify, recorder, run,
          ...(grader ? { gradeJson: grader.forInstance(inst) } : {}) });
        await run.finish({ status: "ok", rowsProcessed: total });
        log.info({ instance: inst.id, clips: total }, "harvest complete");
      } catch (err) {
        if (err instanceof HarvestOutcomeError) total = err.rowsProcessed;
        log.error({ err: (err as Error).message, instance: inst.id }, "harvest failed");
        await run.finish({ status: "error", rowsProcessed: total, errorMessage: (err as Error).message });
      } finally {
        await markHarvestRunComplete(sql, inst.id).catch((e) =>
          log.error({ err: (e as Error).message, instance: inst.id }, "markHarvestRunComplete failed"),
        );
      }
    },
    shouldStop,
  });
}

main().catch((err) => {
  console.error("harvester fatal:", err);
  process.exit(EX_TEMPFAIL);
});

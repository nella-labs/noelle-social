import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { listActiveVideoInternInstances } from "../lib/teardown-db.js";
import { recordRun } from "../lib/worker-runs.js";
import { createBriefer } from "../lib/brief-generate.js";
import { createTextJsonFn } from "../lib/text-backend.js";
import { createVaultKb } from "../lib/vault-grounding.js";
import { BriefingOutcomeError, runBrieferTick } from "./briefer-tick.js";

// W6 briefer (Nova's media intern). Turns an operator-APPROVED draft (status
// 'ready') into a phone-readable RECORDING BRIEF, stored in
// noelle.video_recording_briefs. Routes through the same reliable claude-cli /
// Bedrock text seam as the scripter (Gemini fallback). Deployed as its OWN
// process so a briefer crash can't take down the scripter/harvester.
//
// FLAG-GATED: dormant unless NOELLE_BRIEFER is set. Off (the default) → this
// entrypoint logs and exits without touching the DB, so merging is safe.

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ kind: "briefer", workerId: env.WORKER_ID });

  if (!env.NOELLE_BRIEFER) {
    log.info({}, "NOELLE_BRIEFER off — briefer dormant (no-op); set NOELLE_BRIEFER=1 to enable");
    return;
  }

  const sql = noelleDb();
  const { forInstance, engine, model } = createTextJsonFn(env, { sql, worker: "briefer" });
  const kb = createVaultKb(env);
  log.info({ engine, model, vault: !!kb }, "briefer text backend resolved");

  const boot = await runBootChecks({
    log,
    checks: [{ name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } }],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  const shouldStop = installShutdown(log);
  log.info({}, "video briefer (media intern) up — briefing approved drafts");
  await runWorkerLoop({
    log,
    kind: "briefer",
    pollMs: env.BRIEFER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listActiveVideoInternInstances(sql),
    onTick: async (inst) => {
      const run = await recordRun({ sql, kind: "briefer" });
      let n = 0;
      try {
        n = await runBrieferTick({
          sql, log, instance: inst, briefer: createBriefer(forInstance(inst)), batchLimit: env.BRIEFER_BATCH, model, sourceEngine: engine, kb,
        });
        await run.finish({ status: "ok", rowsProcessed: n });
      } catch (err) {
        if (err instanceof BriefingOutcomeError) n = err.rowsProcessed;
        log.error({ err: (err as Error).message, instance: inst.id }, "briefer tick failed");
        await run.finish({ status: "error", rowsProcessed: n, errorMessage: (err as Error).message });
      }
    },
    shouldStop,
  });
}

main().catch((err) => {
  console.error("briefer fatal:", err);
  process.exit(EX_TEMPFAIL);
});

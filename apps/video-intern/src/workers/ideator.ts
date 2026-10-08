import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import {
  listInstancesWithPendingIdeation,
  markIdeationComplete,
  type PendingIdeationInstance,
} from "../lib/video-ideas-db.js";
import { recordRun } from "../lib/worker-runs.js";
import { createIdeator } from "../lib/video-generate.js";
import { createTextJsonFn } from "../lib/text-backend.js";
import { createVaultKb } from "../lib/vault-grounding.js";
import { runIdeatorTick } from "./ideator-tick.js";

// W4 ideator (Muse). Cost-gated manual run: polls for instances whose studio
// requested ideas (video_ideation_request flag), generates idea cards grounded
// on the Brand Guide + top clips, then clears the flag. Routes through the
// reliable claude-cli / Bedrock text seam (Gemini fallback) — see text-backend.

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ kind: "ideator", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const { forInstance, engine, model } = createTextJsonFn(env, { sql, worker: "ideator" });
  const kb = createVaultKb(env);
  log.info({ engine, model, vault: !!kb }, "ideator text backend resolved");

  const boot = await runBootChecks({
    log,
    checks: [{ name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } }],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  const shouldStop = installShutdown(log);
  log.info({}, "video ideator (Muse) up — polling for requested ideation runs");
  await runWorkerLoop({
    log,
    kind: "ideator",
    pollMs: env.IDEATOR_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listInstancesWithPendingIdeation(sql),
    onTick: async (inst) => {
      const run = await recordRun({ sql, kind: "ideator" });
      let n = 0;
      try {
        n = await runIdeatorTick({ sql, log, instance: inst as PendingIdeationInstance,
          ideator: createIdeator(forInstance(inst)), model, sourceEngine: engine, kb });
        await run.finish({ status: "ok", rowsProcessed: n });
      } catch (err) {
        log.error({ err: (err as Error).message, instance: inst.id }, "ideator tick failed");
        await run.finish({ status: "error", rowsProcessed: n, errorMessage: (err as Error).message });
      } finally {
        await markIdeationComplete(sql, inst.id).catch((e) =>
          log.error({ err: (e as Error).message, instance: inst.id }, "markIdeationComplete failed"),
        );
      }
    },
    shouldStop,
  });
}

main().catch((err) => {
  console.error("ideator fatal:", err);
  process.exit(EX_TEMPFAIL);
});

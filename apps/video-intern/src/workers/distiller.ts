import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { listActiveVideoInternInstances } from "../lib/teardown-db.js";
import { recordRun } from "../lib/worker-runs.js";
import { createVaultKb, resolvePersonalBrandStatePath } from "../lib/vault-grounding.js";
import { runDistillerTick } from "./distiller-tick.js";

// W3 Distill worker. Rolls each creator's teardowns into a Video Brand Guide
// (video_ultra_profiles) + Voyage-embeds clips for studio retrieval. Cheap +
// deterministic (the distillation is heuristic; embeddings are the only API call).
async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ kind: "distiller", workerId: env.WORKER_ID });
  const sql = noelleDb();
  // Personal-brand-state regeneration config (default OFF via NOELLE_PERSONAL_BRAND_STATE).
  // The KB grounds the "How I sound" section; statePath is where the artifact lands
  // (under the first voice dir so the KB can index it). Both null-safe → no-op.
  const personalBrandState = {
    enabled: env.NOELLE_PERSONAL_BRAND_STATE,
    statePath: resolvePersonalBrandStatePath(env),
    kb: createVaultKb(env),
  };
  log.info(
    { enabled: personalBrandState.enabled, hasPath: !!personalBrandState.statePath },
    "personal-brand-state config resolved",
  );

  const boot = await runBootChecks({
    log,
    checks: [{ name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } }],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  const shouldStop = installShutdown(log);
  log.info({}, "video distiller (W3) up — building the Video Brand Guide");
  await runWorkerLoop({
    log,
    kind: "distiller",
    pollMs: env.DISTILLER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listActiveVideoInternInstances(sql),
    onTick: async (inst) => {
      const run = await recordRun({ sql, kind: "distiller" });
      try {
        const r = await runDistillerTick({
          sql,
          log,
          instance: inst,
          ...(env.VOYAGE_API_KEY ? { voyageApiKey: env.VOYAGE_API_KEY } : {}),
          embedLimit: env.DISTILLER_EMBED_BATCH,
          personalBrandState,
        });
        await run.finish({ status: "ok", rowsProcessed: r.profiles + r.embedded });
      } catch (err) {
        log.error({ err: (err as Error).message, instance: inst.id }, "distiller tick failed");
        await run.finish({ status: "error", errorMessage: (err as Error).message });
      }
    },
    shouldStop,
  });
}

main().catch((err) => {
  console.error("distiller fatal:", err);
  process.exit(EX_TEMPFAIL);
});

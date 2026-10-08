import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { listActiveVideoInternInstances } from "../lib/teardown-db.js";
import { recordRun } from "../lib/worker-runs.js";
import { createScripter } from "../lib/video-generate.js";
import { createTextJsonFn } from "../lib/text-backend.js";
import { createVaultKb, resolvePersonalBrandStatePath } from "../lib/vault-grounding.js";
import { runScripterTick, ScripterOutcomeError } from "./scripter-tick.js";

// W4 scripter (Blueprint + Scribe). Always-on: polls active instances for
// 'approved' video_ideas, generates a timed structure + script + asset
// suggestions grounded on the Brand Guide + exemplar clips. Routes through the
// reliable claude-cli / Bedrock text seam (Gemini fallback) — see text-backend.

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ kind: "scripter", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const { forInstance, engine, model } = createTextJsonFn(env, { sql, worker: "scripter" });
  const kb = createVaultKb(env);
  // Personal-brand-state artifact path (null unless a vault/override is configured).
  // When NOELLE_PERSONAL_BRAND_STATE is on and the file exists, the scripter prefers
  // it ahead of BM25 anchors; otherwise this is inert. Fail-open at read time.
  const statePath = env.NOELLE_PERSONAL_BRAND_STATE ? resolvePersonalBrandStatePath(env) : null;
  const verify = {
    enabled: env.NOELLE_DRAFTER_VERIFY,
    retries: env.NOELLE_DRAFTER_VERIFY_RETRIES,
    voiceFloor: env.NOELLE_DRAFTER_VOICE_FLOOR,
  };
  log.info({ engine, model, vault: !!kb, verify: verify.enabled, semantic: !!env.VOYAGE_API_KEY }, "scripter text backend resolved");

  const boot = await runBootChecks({
    log,
    checks: [{ name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } }],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  const shouldStop = installShutdown(log);
  log.info({}, "video scripter (Scribe) up — drafting approved ideas");
  await runWorkerLoop({
    log,
    kind: "scripter",
    pollMs: env.SCRIPTER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listActiveVideoInternInstances(sql),
    onTick: async (inst) => {
      const json = forInstance(inst);
      const run = await recordRun({ sql, kind: "scripter" });
      let n = 0;
      try {
        n = await runScripterTick({
          sql, log, instance: inst, scripter: createScripter(json), batchLimit: env.SCRIPTER_BATCH, model, sourceEngine: engine, kb,
          statePath, voyageApiKey: env.VOYAGE_API_KEY, verify, verifyJson: json,
        });
        await run.finish({ status: "ok", rowsProcessed: n });
      } catch (err) {
        if (err instanceof ScripterOutcomeError) n = err.rowsProcessed;
        log.error({ err: (err as Error).message, instance: inst.id }, "scripter tick failed");
        await run.finish({ status: "error", rowsProcessed: n, errorMessage: (err as Error).message });
      }
    },
    shouldStop,
  });
}

main().catch((err) => {
  console.error("scripter fatal:", err);
  process.exit(EX_TEMPFAIL);
});

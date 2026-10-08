import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { listActiveVideoInternInstances } from "../lib/teardown-db.js";
import { recordRun } from "../lib/worker-runs.js";
import { createVertexVideoAnalyzer } from "../lib/teardown-analyze.js";
import { TeardownOutcomeError, runTeardownTick } from "./teardown-tick.js";
import { createVideoModelMetering } from "../lib/text-backend.js";

// W2 Teardown worker. Continuously analyses the backlog of harvested clips that
// have no video_teardowns row, deep-tier first. Vertex Gemini (flash bulk /
// 2.5-pro deep). Durable claims precede paid analysis; uncertain outcomes need
// explicit recovery. Independent clips continue. This worker never publishes.
async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ kind: "teardown", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const scope = createVideoModelMetering(sql, "teardown");
  const analyzerOptions = {
    project: env.GCP_PROJECT,
    location: env.VERTEX_LOCATION,
    apiKey: env.NOELLE_GEMINI_API_KEY,
  };

  const boot = await runBootChecks({
    log,
    checks: [{ name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } }],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  const shouldStop = installShutdown(log);
  log.info({}, "video teardown (W2) up — analysing the clip backlog");
  await runWorkerLoop({
    log,
    kind: "teardown",
    pollMs: env.TEARDOWN_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listActiveVideoInternInstances(sql),
    onTick: async (inst) => {
      const metering = scope(inst, "vertex");
      const bulkAnalyzer = createVertexVideoAnalyzer({ ...analyzerOptions, model: "gemini-2.5-flash", accountingModel: "gemini-2-5-flash", metering });
      const deepAnalyzer = createVertexVideoAnalyzer({ ...analyzerOptions, model: "gemini-2.5-pro", accountingModel: "gemini-2-5-pro", metering });
      const run = await recordRun({ sql, kind: "teardown" });
      let n = 0;
      try {
        n = await runTeardownTick({
          sql,
          log,
          instance: inst,
          bulkAnalyzer,
          deepAnalyzer,
          batchLimit: env.TEARDOWN_BATCH,
          dailyCap: env.TEARDOWN_DAILY_CAP,
          ...(env.WHISPER_MODEL ? { whisperModel: env.WHISPER_MODEL } : {}),
        });
        await run.finish({ status: "ok", rowsProcessed: n });
      } catch (err) {
        if (err instanceof TeardownOutcomeError) n = err.rowsProcessed;
        log.error({ err: (err as Error).message, instance: inst.id }, "teardown tick failed");
        await run.finish({ status: "error", rowsProcessed: n, errorMessage: (err as Error).message });
      }
    },
    shouldStop,
  });
}

main().catch((err) => {
  console.error("teardown fatal:", err);
  process.exit(EX_TEMPFAIL);
});

import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { listActiveVideoInternInstances } from "../lib/teardown-db.js";
import { recordRun } from "../lib/worker-runs.js";
import { videoSkillsDir } from "../lib/skill-emit.js";
import { runSkillerTick } from "./skiller-tick.js";

// W3b Skiller worker. Reads the distilled Video Brand Guides (video_ultra_profiles)
// and emits one SKILL.md per pattern into the operator vault. Pure FS work — no
// LLM, no external API — so it's cheap and safe to run on a slow poll. When no
// skills dir is configured it idles (no-op), same as any vault-less self-host.
async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ kind: "skiller", workerId: env.WORKER_ID });
  const sql = noelleDb();

  const boot = await runBootChecks({
    log,
    checks: [{ name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } }],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  const shouldStop = installShutdown(log);
  const dir = videoSkillsDir(env);
  if (!dir) {
    log.warn({}, "skiller: no NOELLE_VIDEO_SKILLS_DIR / NOELLE_VAULT_DIR set — idling (no-op)");
  } else {
    log.info({ dir }, "video skiller up — emitting SKILL.md per distilled pattern");
  }

  await runWorkerLoop({
    log,
    kind: "skiller",
    pollMs: env.SKILLER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    // No skills dir → nothing to process; return [] so the loop just idles.
    listActive: () => (dir ? listActiveVideoInternInstances(sql) : Promise.resolve([])),
    onTick: async (inst) => {
      if (!dir) return; // defensive: listActive already returns [] in this case
      const run = await recordRun({ sql, kind: "skiller" });
      try {
        const r = await runSkillerTick({ sql, log, instance: inst, dir });
        await run.finish({ status: "ok", rowsProcessed: r.written });
      } catch (err) {
        log.error({ err: (err as Error).message, instance: inst.id }, "skiller tick failed");
        await run.finish({ status: "error", errorMessage: (err as Error).message });
      }
    },
    shouldStop,
  });
}

main().catch((err) => {
  console.error("skiller fatal:", err);
  process.exit(EX_TEMPFAIL);
});

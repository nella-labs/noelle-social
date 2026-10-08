import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createGcsStorage, createVaultStorage } from "@noelle/runtime/vault-storage";
import { loadConfig } from "./config.js";
import { scanVault } from "./scan.js";
import { reconcile, additiveOnly, type FileRef } from "./reconcile.js";
import { applyPlan, type MirrorDeps, type MirrorStorage } from "./mirror.js";
import { startWatcher } from "./watch.js";

const log = (msg: string) => console.log(`[vault-daemon] ${msg}`);

async function main(): Promise<void> {
  const cfg = loadConfig();
  const once = process.argv.includes("--once");
  // Additive by default: only upload, never delete. Deletions require an
  // explicit --prune (and stay guarded). --force lifts the prune guard.
  const prune = process.argv.includes("--prune");
  const force = process.argv.includes("--force");

  log(`vault=${cfg.vaultDir} → gs://${cfg.bucket}/${cfg.prefix} (${prune ? "prune" : "additive"})`);

  const vault = createVaultStorage(await createGcsStorage());
  const storage: MirrorStorage = {
    writeText: ({ filename, body }) =>
      vault.writeText({ bucket: cfg.bucket, prefix: cfg.prefix, filename, body }),
    delete: ({ filename }) => vault.delete({ bucket: cfg.bucket, prefix: cfg.prefix, filename }),
  };

  const deps: MirrorDeps = {
    bucket: cfg.bucket,
    prefix: cfg.prefix,
    deleteGuardPct: cfg.deleteGuardPct,
    readLocal: (relPath) => readFile(join(cfg.vaultDir, relPath), "utf-8"),
    storage,
  };
  const readRemote = async (): Promise<FileRef[]> =>
    (await vault.list({ bucket: cfg.bucket, prefix: cfg.prefix }))
      // Defensive: GCS getFiles({prefix}) only returns prefix-matching objects,
      // but never slice a path that doesn't start with the prefix.
      .filter((f) => f.path.startsWith(cfg.prefix))
      .map((f) => ({
        relPath: f.path.slice(cfg.prefix.length),
        md5: f.md5 ?? "",
      }));
  // Startup reconcile — self-heals the mirror after downtime.
  const local = await scanVault(cfg.vaultDir);
  const remote = await readRemote();
  const fullPlan = reconcile(local, remote);
  const plan = prune ? fullPlan : additiveOnly(fullPlan);
  if (prune) {
    log(`reconcile (prune): ${plan.toUpload.length} to upload, ${plan.toDelete.length} to delete`);
  } else {
    log(
      `reconcile (additive): ${plan.toUpload.length} to upload` +
        (fullPlan.toDelete.length > 0
          ? `, ${fullPlan.toDelete.length} stale remote left in place (pass --prune to delete)`
          : ""),
    );
  }

  const result = await applyPlan(plan, remote.length, deps, { force });

  if (result.deletesWithheld > 0) {
    log(
      `⚠ withheld ${result.deletesWithheld} deletes (> ${cfg.deleteGuardPct}% of remote). ` +
        `Re-run with --force if intentional.`,
    );
  }
  log(`startup done: ${result.uploaded} uploaded, ${result.deleted} deleted`);

  if (once) return;

  log(`watching for changes… (${prune ? "prune" : "additive — local deletes are NOT mirrored"})`);
  const watcher = startWatcher({
    vaultDir: cfg.vaultDir,
    debounceMs: cfg.debounceMs,
    deps,
    readRemote,
    prune,
    force,
    log,
    onFailure: (error) => {
      void shutdown(error);
    },
  });

  let shutdownPromise: Promise<void> | undefined,
    exitCode = 0;
  const shutdown = (failure?: Error): Promise<void> => {
    if (failure) {
      exitCode = 1;
      console.error(`[vault-daemon] fatal: ${failure.message}`);
    }
    shutdownPromise ??= (async () => {
      log("shutting down");
      try {
        await watcher.close();
      } catch (error) {
        exitCode = 1;
        console.error(`[vault-daemon] shutdown failed: ${(error as Error).message}`);
      }
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
}

main().catch((err) => {
  console.error(`[vault-daemon] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});

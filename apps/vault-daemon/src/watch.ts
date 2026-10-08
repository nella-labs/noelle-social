import { relative, sep } from "node:path";
import chokidar from "chokidar";
import { applyPlan, type MirrorDeps } from "./mirror.js";
import type { FileRef } from "./reconcile.js";

const MAX_PENDING_PATHS = 256;
type Change = { kind: "upload" | "unlink"; due: number };

/** Coalesce local changes and drain mirror work in order, including graceful close. */
export function startWatcher(args: {
  vaultDir: string;
  debounceMs: number;
  deps: MirrorDeps;
  readRemote(): Promise<FileRef[]>;
  prune?: boolean;
  force?: boolean;
  log: (msg: string) => void;
  onFailure: (error: Error) => void;
}): { close(): Promise<void> } {
  const { vaultDir, debounceMs, deps, readRemote, log, prune = false, force = false } = args;
  const pending = new Map<string, Change>();
  let timer: NodeJS.Timeout | undefined, active: Promise<void> | undefined;
  let accepting = true,
    closing = false,
    closePromise: Promise<void> | undefined;
  const watcher = chokidar.watch(vaultDir, {
    ignoreInitial: true,
    // Only relative dot segments are ignored; a dotted vault root remains valid.
    ignored: (path: string) =>
      relative(vaultDir, path)
        .split(sep)
        .some((segment) => segment.startsWith(".")),
  });

  async function applyBatch(batch: Array<[string, Change]>) {
    for (const [path, change] of batch) {
      if (change.kind !== "upload") continue;
      try {
        await applyPlan({ toUpload: [path], toDelete: [] }, 0, deps);
        log(`↑ ${path}`);
      } catch (error) {
        log(`! upload failed ${path}: ${(error as Error).message}`);
      }
    }
    const requested = batch.filter(([, change]) => change.kind === "unlink").map(([path]) => path);
    if (requested.length === 0) return;
    try {
      // A failed complete listing cannot authorize even one deletion.
      const remote = await readRemote(),
        present = new Set(remote.map((file) => file.relPath));
      const toDelete = requested.filter((path) => present.has(path));
      const result = await applyPlan({ toUpload: [], toDelete }, remote.length, deps, { force });
      if (result.deletesWithheld)
        log(`! withheld ${result.deletesWithheld} deletes (> ${deps.deleteGuardPct}% of remote)`);
      else for (const path of toDelete) log(`✗ ${path}`);
    } catch (error) {
      log(`! delete batch failed: ${(error as Error).message}`);
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (active || pending.size === 0) return;
    if (closing) {
      pump();
      return;
    }
    const due = Math.min(...Array.from(pending.values(), (change) => change.due));
    timer = setTimeout(pump, Math.max(0, due - Date.now()));
  }
  function pump() {
    if (active) return;
    timer = undefined;
    const now = Date.now();
    const batch = Array.from(pending).filter(([, change]) => closing || change.due <= now);
    if (batch.length === 0) {
      schedule();
      return;
    }
    for (const [path] of batch) pending.delete(path);
    active = applyBatch(batch).finally(() => {
      active = undefined;
      schedule();
    });
  }
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    accepting = false;
    closing = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    closePromise = (async () => {
      let failure: unknown;
      try {
        await watcher.close();
      } catch (error) {
        failure = error;
      }
      while (active || pending.size) {
        if (!active) pump();
        await active;
      }
      if (failure) throw failure;
    })();
    return closePromise;
  }
  function enqueue(fullPath: string, kind: Change["kind"]) {
    if (!accepting || !fullPath.toLowerCase().endsWith(".md")) return;
    const path = relative(vaultDir, fullPath).split(sep).join("/");
    if (!pending.has(path) && pending.size >= MAX_PENDING_PATHS) {
      const error = new Error(`Vault watcher queue exceeds ${MAX_PENDING_PATHS} pending paths`);
      accepting = false;
      log(`! ${error.message}`);
      void close().then(
        () => args.onFailure(error),
        (cleanup) => args.onFailure(new AggregateError([error, cleanup], error.message)),
      );
      return;
    }
    pending.set(path, { kind, due: Date.now() + debounceMs });
    schedule();
  }
  watcher.on("add", (path: string) => enqueue(path, "upload"));
  watcher.on("change", (path: string) => enqueue(path, "upload"));
  if (prune) watcher.on("unlink", (path: string) => enqueue(path, "unlink"));
  return { close };
}

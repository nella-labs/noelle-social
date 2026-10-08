import type { SyncPlan } from "./reconcile.js";

/**
 * Storage surface the mirror needs — a structural subset of
 * `@noelle/runtime` `VaultStorage` with bucket/prefix pre-bound at the
 * call site, so tests pass a fake without the GCS SDK.
 */
export interface MirrorStorage {
  writeText(args: { filename: string; body: string }): Promise<void>;
  delete(args: { filename: string }): Promise<void>;
}

export interface MirrorDeps {
  bucket: string;
  prefix: string;
  deleteGuardPct: number;
  /** Read the local file body for a vault-relative path. */
  readLocal(relPath: string): Promise<string>;
  storage: MirrorStorage;
}

export interface ApplyResult {
  uploaded: number;
  deleted: number;
  deletesWithheld: number;
}

/**
 * Apply a reconcile plan. Uploads always run. Deletes run only when they
 * stay under the guard percentage of the current remote file count —
 * unless `force` is set. This stops a moved/renamed vault root (which
 * would surface as a mass-delete plan) from wiping the cloud copy.
 */
export async function applyPlan(
  plan: SyncPlan,
  remoteCount: number,
  deps: MirrorDeps,
  opts: { force?: boolean } = {},
): Promise<ApplyResult> {
  for (const relPath of plan.toUpload) {
    const body = await deps.readLocal(relPath);
    await deps.storage.writeText({ filename: relPath, body });
  }

  const deletePct = remoteCount > 0 ? (plan.toDelete.length / remoteCount) * 100 : 0;
  const guardTripped =
    !opts.force && plan.toDelete.length > 0 && deletePct > deps.deleteGuardPct;

  if (guardTripped) {
    return { uploaded: plan.toUpload.length, deleted: 0, deletesWithheld: plan.toDelete.length };
  }

  for (const relPath of plan.toDelete) {
    await deps.storage.delete({ filename: relPath });
  }
  return { uploaded: plan.toUpload.length, deleted: plan.toDelete.length, deletesWithheld: 0 };
}

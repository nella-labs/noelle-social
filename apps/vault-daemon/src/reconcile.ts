/**
 * Pure reconcile core: compares the local markdown set against the remote
 * GCS listing (both identified by relative path + base64 md5) and returns
 * the upload/delete plan. No I/O — this is the unit-tested heart of the
 * mirror. `relPath` is the vault-relative path (no bucket prefix), which
 * is exactly what `vaultStorage.writeText`/`delete` expect as `filename`.
 */
export interface FileRef {
  relPath: string;
  md5: string;
}

export interface SyncPlan {
  toUpload: string[];
  toDelete: string[];
}

export function reconcile(local: FileRef[], remote: FileRef[]): SyncPlan {
  const remoteByPath = new Map(remote.map((r) => [r.relPath, r.md5]));
  const localByPath = new Map(local.map((l) => [l.relPath, l.md5]));

  const toUpload = local
    .filter((l) => remoteByPath.get(l.relPath) !== l.md5)
    .map((l) => l.relPath)
    .sort();

  const toDelete = remote
    .filter((r) => !localByPath.has(r.relPath))
    .map((r) => r.relPath)
    .sort();

  return { toUpload, toDelete };
}

/**
 * Strip deletions from a plan — additive (upload-only) mode. This is the
 * daemon's DEFAULT: a manual sync only ever uploads new/changed files and
 * never prunes the cloud copy. Deletes happen only with an explicit
 * `--prune`. Keeps an iCloud eviction (or a fat-fingered local delete)
 * from silently shrinking the vault the X agent reads.
 */
export function additiveOnly(plan: SyncPlan): SyncPlan {
  return { toUpload: plan.toUpload, toDelete: [] };
}

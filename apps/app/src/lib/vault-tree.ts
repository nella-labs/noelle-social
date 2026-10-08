import type { VaultFileMeta } from "@noelle/runtime/vault-storage";
import type { VaultFile, VaultFolder, VaultNode } from "./vault-types";

/** Strip the tenant prefix from a full GCS object path. Shared by
 * buildVaultTree + vaultStats so they always agree on the relative path. */
function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Turn a flat GCS listing (paths include the tenant prefix, e.g.
 * `workspace/brand/voice.md`) into the nested `VaultNode[]` the
 * `VaultBrowser` renders. The prefix is stripped; folders are synthesised
 * from path segments. File bodies are not loaded here — the browser
 * fetches them on demand via `/api/vault/file`.
 */
export function buildVaultTree(files: VaultFileMeta[], prefix: string): VaultNode[] {
  const roots: VaultNode[] = [];
  const folders = new Map<string, VaultFolder>();

  const getFolder = (path: string, name: string, parent: VaultNode[]): VaultFolder => {
    const existing = folders.get(path);
    if (existing) return existing;
    const folder: VaultFolder = { type: "folder", name, path, children: [] };
    folders.set(path, folder);
    parent.push(folder);
    return folder;
  };

  for (const f of files) {
    const rel = stripPrefix(f.path, prefix);
    if (rel === "" || rel.endsWith("/")) continue; // prefix placeholder / folder marker
    const segments = rel.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    let cursor = roots;
    let accum = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      accum = accum ? `${accum}/${seg}` : seg;
      cursor = getFolder(accum, seg, cursor).children;
    }

    const name = segments[segments.length - 1]!;
    const file: VaultFile = {
      type: "file",
      name,
      path: rel,
      lastModifiedISO: f.updatedISO,
      anchoredBy: [],
    };
    cursor.push(file);
  }

  return roots;
}

export function vaultStats(
  files: VaultFileMeta[],
  prefix = "",
): {
  folders: number;
  files: number;
  bytes: number;
} {
  const folderPaths = new Set<string>();
  let fileCount = 0;
  let bytes = 0;
  for (const f of files) {
    const rel = stripPrefix(f.path, prefix);
    if (rel === "" || rel.endsWith("/")) continue;
    fileCount += 1;
    bytes += f.size;
    const segs = rel.split("/").filter(Boolean);
    let accum = "";
    for (let i = 0; i < segs.length - 1; i++) {
      accum = accum ? `${accum}/${segs[i]}` : segs[i]!;
      folderPaths.add(accum);
    }
  }
  return { folders: folderPaths.size, files: fileCount, bytes };
}

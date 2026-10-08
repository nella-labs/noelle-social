import { cliTimeoutMs } from "./cliProcess.js";
import type { GcsListOptions } from "./gcsStorageReader.js";
import { assertSafeVaultPrefix } from "./vaultPaths.js";
import { GCS_METADATA_PAGE_LIMIT, GCS_METADATA_PAGE_TOKEN_LIMIT } from "./gcsLimits.js";

export const VAULT_LIST_PAGE_LIMIT = GCS_METADATA_PAGE_LIMIT;
export const VAULT_LIST_PAGE_TOKEN_LIMIT = GCS_METADATA_PAGE_TOKEN_LIMIT;
export const VAULT_LIST_DEFAULT_LIMIT = 50;
export interface VaultFileMeta { path: string; size: number; updatedISO: string; md5?: string }
export interface VaultFilesPage { files: VaultFileMeta[]; nextPageToken: string | null }
export type VaultListPageArgs = { bucket: string; prefix: string; pageToken?: string; limit?: number };
type File = { name: string; metadata: { size?: string | number; updated?: string; md5Hash?: string } };
export interface VaultListingDeps {
  bucket(name: string): { getFiles(options: GcsListOptions): Promise<[File[], { pageToken: string }?]> };
}

/** One explicit metadata page, or a complete bounded listing for mirror reconciliation. */
export function createVaultListing(deps: VaultListingDeps) {
  async function listPage(args: VaultListPageArgs, timeoutMs?: number): Promise<VaultFilesPage> {
    assertSafeVaultPrefix(args.prefix);
    const limit = args.limit ?? VAULT_LIST_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > VAULT_LIST_PAGE_LIMIT ||
        (args.pageToken !== undefined && (typeof args.pageToken !== "string" || !args.pageToken || args.pageToken.length > VAULT_LIST_PAGE_TOKEN_LIMIT))) {
      throw new RangeError("Invalid vault listing page");
    }
    const [entries, next] = await deps.bucket(args.bucket).getFiles({ prefix: args.prefix, autoPaginate: false, maxResults: limit,
      ...(args.pageToken === undefined ? {} : { pageToken: args.pageToken }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    if (!Array.isArray(entries) || entries.length > limit || (next !== undefined &&
        (typeof next.pageToken !== "string" || !next.pageToken || next.pageToken.length > VAULT_LIST_PAGE_TOKEN_LIMIT))) throw new Error("Invalid vault metadata page");
    const files = entries.map(file => {
      const size = typeof file.metadata.size === "string" && /^\d+$/.test(file.metadata.size)
        ? Number(file.metadata.size) : file.metadata.size;
      if (!file.name.startsWith(args.prefix) || !Number.isSafeInteger(size) || Number(size) < 0 ||
          typeof file.metadata.updated !== "string" || !Number.isFinite(Date.parse(file.metadata.updated))) throw new Error("Invalid vault file metadata");
      return { path: file.name, size: size as number, updatedISO: file.metadata.updated,
        ...(file.metadata.md5Hash === undefined ? {} : { md5: file.metadata.md5Hash }) };
    }).filter(file => file.path.length > args.prefix.length);
    return { files, nextPageToken: next?.pageToken ?? null };
  }
  return {
    listPage,
    async list(args: { bucket: string; prefix: string }): Promise<VaultFileMeta[]> {
      const deadline = performance.now() + cliTimeoutMs(30_000);
      const files: VaultFileMeta[] = [], tokens = new Set<string>(), names = new Set<string>();
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new Error("Vault listing timeout");
        const result = await listPage({ ...args, limit: VAULT_LIST_PAGE_LIMIT, ...(pageToken === undefined ? {} : { pageToken }) }, remaining);
        if (performance.now() >= deadline) throw new Error("Vault listing timeout");
        for (const file of result.files) {
          if (names.has(file.path)) throw new Error("Duplicate vault metadata");
          names.add(file.path); files.push(file);
        }
        if (result.nextPageToken === null) return files;
        if (tokens.has(result.nextPageToken)) throw new Error("Invalid vault metadata continuation");
        tokens.add(result.nextPageToken); pageToken = result.nextPageToken;
      }
      throw new Error("Vault listing exceeds its complete page limit");
    },
  };
}

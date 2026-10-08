import type { GetSignedUrlConfig } from "@google-cloud/storage";
import { createVaultListing, type VaultFileMeta, type VaultFilesPage, type VaultListPageArgs, type VaultListingDeps } from "./vaultListing.js";
import { assertSafeVaultFilename, assertSafeVaultPrefix } from "./vaultPaths.js";
import { assertVaultText, decodeVaultText } from "./vaultText.js";
export { VaultSourceEncodingError } from "./vaultText.js";
export { assertSafeVaultPrefix } from "./vaultPaths.js";
export { VAULT_LIST_DEFAULT_LIMIT, VAULT_LIST_PAGE_LIMIT, VAULT_LIST_PAGE_TOKEN_LIMIT } from "./vaultListing.js";
export type { VaultFileMeta, VaultFilesPage, VaultListPageArgs } from "./vaultListing.js";

/**
 * Tenant vault operations use the bucket and directory prefix supplied after
 * authorization. Management reads one metadata page; mirror reconciliation
 * requires a complete listing within ten pages and one thirty-second budget.
 * File paths and signed URL lifetimes are checked before storage admission.
 * Complete source text retains the shared byte limit and strict encoding.
 * Production dependencies compose bounded object/metadata transport and SDK
 * V4 signing; structural dependencies keep tests independent of cloud access.
 */

export interface VaultStorage {
  listPage(args: VaultListPageArgs): Promise<VaultFilesPage>;
  list(args: { bucket: string; prefix: string }): Promise<VaultFileMeta[]>;
  signUpload(args: {
    bucket: string;
    prefix: string;
    filename: string;
    contentType: string;
    ttlSeconds?: number;
  }): Promise<string>;
  delete(args: { bucket: string; prefix: string; filename: string }): Promise<void>;
  writeText(args: {
    bucket: string;
    prefix: string;
    filename: string;
    body: string;
    contentType?: string;
  }): Promise<void>;
  readText(args: { bucket: string; prefix: string; filename: string }): Promise<string>;
}

/**
 * Minimal structural type capturing the parts of `@google-cloud/storage`'s
 * `Bucket` we actually use. Keeps the test fake small and lets us avoid
 * importing the real SDK at the test layer.
 */
interface BucketLike extends ReturnType<VaultListingDeps["bucket"]> {
  file(name: string): {
    getSignedUrl(opts: GetSignedUrlConfig): Promise<[string]>;
    delete(): Promise<unknown>;
    save(body: string | Buffer, opts?: Record<string, unknown>): Promise<unknown>;
    download(): Promise<[Buffer]>;
  };
}

export interface StorageDeps {
  bucket(name: string): BucketLike;
}

export function createVaultStorage(deps: StorageDeps): VaultStorage {
  return {
    ...createVaultListing(deps),
    async signUpload({ bucket, prefix, filename, contentType, ttlSeconds = 600 }) {
      assertSafeVaultPrefix(prefix);
      assertSafeVaultFilename(filename);
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 604800) throw new RangeError("Invalid GCS signed URL lifetime");
      const fullPath = `${prefix}${filename}`;
      const [url] = await deps.bucket(bucket).file(fullPath).getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + ttlSeconds * 1000,
        contentType,
      });
      return url;
    },
    async delete({ bucket, prefix, filename }) {
      assertSafeVaultPrefix(prefix);
      assertSafeVaultFilename(filename);
      await deps.bucket(bucket).file(`${prefix}${filename}`).delete();
    },
    async writeText({ bucket, prefix, filename, body, contentType = "text/markdown" }) {
      assertSafeVaultPrefix(prefix);
      assertSafeVaultFilename(filename);
      assertVaultText(body);
      await deps.bucket(bucket).file(`${prefix}${filename}`).save(body, {
        contentType,
        resumable: false,
      });
    },
    async readText({ bucket, prefix, filename }) {
      assertSafeVaultPrefix(prefix);
      assertSafeVaultFilename(filename);
      const [buf] = await deps.bucket(bucket).file(`${prefix}${filename}`).download();
      if (!Buffer.isBuffer(buf)) throw new Error("Invalid vault source body");
      return decodeVaultText(buf);
    },
  };
}

/**
 * Construct canonical bounded GCS transport with SDK V4 signing. Lazy import
 * so the runtime package doesn't pay the cost until storage is actually
 * touched — most workers (drafter, classifier) never need it.
 */
export async function createGcsStorage(options: { timeoutMs?: number } = {}): Promise<StorageDeps> {
  const { createGcsVaultStorage } = await import("./gcsVaultStorage.js");
  return createGcsVaultStorage(options);
}

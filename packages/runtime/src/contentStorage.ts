// Content media storage abstraction.
//
// One interface, two backends — identical call sites, env-selected:
//   - self-host: a local directory the api-vm serves at /media/<key>.
//   - prod: a dedicated GCS media bucket (NOELLE_MEDIA_BUCKET), private, with
//     V4 signed read URLs. Keys are org-scoped (<orgId>/media/<uuid>.<ext>), so
//     no extra prefix is needed.
// Bytes are written by the api-vm (they arrive base64-encoded), so neither
// backend needs browser-side signed uploads — the only difference is where
// `put` writes and what URL it returns.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ContentStorage {
  put(a: { key: string; bytes: Uint8Array; contentType: string }): Promise<{ url: string }>;
  delete(key: string): Promise<void>;
  /** Mint a current transferable read link for an already-stored key. */
  resolveUrl?(key: string): Promise<string>;
  /** Local backends only: the absolute path for a key (for serving). */
  localPath?(key: string): string;
}

// Storage keys are built from an org slug + a caller-supplied uuid, never raw
// user input. This guard is defence-in-depth against a bad caller: no
// traversal, no absolute paths, no leading slash.
export function assertSafeKey(key: string): void {
  if (!key || key.startsWith("/") || key.includes("..") || /\\/.test(key)) {
    throw new Error(`unsafe storage key: ${JSON.stringify(key)}`);
  }
}

/** Resolve a validated storage key under the configured local media root. */
export function localContentMediaPath(dir: string, key: string): string {
  assertSafeKey(key);
  const root = resolve(dir);
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(root + "/")) {
    throw new Error("resolved path escapes media dir");
  }
  return path;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/** File extension for a mime type (default "bin"). */
export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? "bin";
}

/** `<orgSlug>/media/<id>.<ext>` — the storage-agnostic handle for one asset. */
export function mediaKey(orgSlug: string, id: string, ext: string): string {
  // Drop dots from the slug so a hostile slug can't smuggle a ".." segment.
  const slug = orgSlug.replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin";
  const key = `${slug}/media/${id}.${safeExt}`;
  assertSafeKey(key);
  return key;
}

/** Local-disk backend (self-host). Files live under `dir`; the api-vm serves
 * them at `${publicBaseUrl}/media/<key>`. */
export function createLocalContentStorage(opts: {
  dir: string;
  publicBaseUrl: string;
}): ContentStorage {
  const full = (key: string) => localContentMediaPath(opts.dir, key);
  const base = opts.publicBaseUrl.replace(/\/$/, "");
  return {
    async put({ key, bytes }) {
      const p = full(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
      return { url: `${base}/media/${key}` };
    },
    async delete(key) {
      await rm(full(key), { force: true });
    },
    async resolveUrl(key) { full(key); return `${base}/media/${key}`; },
    localPath(key) {
      return full(key);
    },
  };
}

// GCS ops are dependency-injected (mirrors vaultStorage) so the api-vm wires the
// real @google-cloud/storage Bucket and tests can stub it.
export interface GcsContentOps {
  bucket: string;
  /** Write bytes at `<prefix><key>`. */
  save(fullPath: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Resolve a fetch URL (public or signed) for `<prefix><key>`. */
  resolveUrl(fullPath: string): Promise<string> | string;
  /** Remove `<prefix><key>`. */
  remove(fullPath: string): Promise<void>;
  /** Per-org key prefix, e.g. "<orgSlug>/" — keys already include the slug, so
   * default "" unless the bucket layout needs an extra prefix. */
  prefix?: string;
}

/** GCS backend (prod). */
export function createGcsContentStorage(ops: GcsContentOps): ContentStorage {
  const prefix = ops.prefix ?? "";
  const path = (key: string) => {
    assertSafeKey(key);
    return `${prefix}${key}`;
  };
  return {
    async put({ key, bytes, contentType }) {
      const p = path(key);
      await ops.save(p, bytes, contentType);
      return { url: await ops.resolveUrl(p) };
    },
    async delete(key) {
      await ops.remove(path(key));
    },
    async resolveUrl(key) { return ops.resolveUrl(path(key)); },
  };
}

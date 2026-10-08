import { BoundedProcessQueue } from "@noelle/process";
import { batchMap } from "./batchMap.js";
import { buildChunkIndex, type ChunkIndex } from "./bm25Index.js";
import { chunkMarkdown, type MarkdownChunk } from "./markdownChunker.js";
import { cliTimeoutMs } from "./cliProcess.js";
import { GCS_MARKDOWN_FILE_BYTES, type GcsStorageReader, type GcsStorageFile } from "./gcsStorageReader.js";
import { assertSafeVaultPrefix } from "./vaultPaths.js";
import { GCS_METADATA_PAGE_LIMIT, GCS_METADATA_PAGE_TOKEN_LIMIT } from "./gcsLimits.js";

const MAX_FILES = 200, MAX_ENTRIES = 1000, MAX_CHUNKS = 2000;
const MAX_WORKSPACE_BYTES = 4 * 1024 * 1024, MAX_CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_ENTRIES = 32, DEFAULT_TTL_MS = 15 * 60 * 1000;
export type CachedGcsWorkspace = { chunks: ReadonlyArray<MarkdownChunk>; index: ChunkIndex; loadedAt: number; bytes: number };

/** Admit a complete bounded corpus; cache only successful generation-pinned loads. */
export function createGcsWorkspaceLoader(options: {
  bucket: string;
  storage: GcsStorageReader;
  workspaceToPrefix(workspace: string): string;
  cacheTtlMs?: number;
  timeoutMs?: number;
}) {
  const ttl = options.cacheTtlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttl) || ttl < 0 || ttl > DEFAULT_TTL_MS) throw new RangeError("Invalid GCS cache lifetime");
  const timeout = cliTimeoutMs(options.timeoutMs ?? 30_000);
  const cache = new Map<string, CachedGcsWorkspace>(), loading = new Map<string, Promise<CachedGcsWorkspace>>();
  const admission = new BoundedProcessQueue();
  let cacheBytes = 0;
  const forget = (key: string) => { const old = cache.get(key); if (old) cacheBytes -= old.bytes; cache.delete(key); };
  return async (workspace: string): Promise<CachedGcsWorkspace> => {
    const prefix = options.workspaceToPrefix(workspace);
    assertSafeVaultPrefix(prefix);
    const cached = cache.get(prefix);
    if (cached && Date.now() - cached.loadedAt < ttl) { cache.delete(prefix); cache.set(prefix, cached); return cached; }
    forget(prefix);
    const prior = loading.get(prefix); if (prior) return prior;
    admission.checkAvailable();
    const deadline = performance.now() + timeout;
    const remaining = () => {
      const value = Math.floor(deadline - performance.now());
      if (value < 1) throw new Error("GCS workspace timeout");
      return value;
    };
    const promise = admission.run(deadline, async () => {
      const bucket = options.storage.bucket(options.bucket), files: GcsStorageFile[] = [];
      const tokens = new Set<string>(), names = new Set<string>();
      let pageToken: string | undefined, entries = 0;
      do {
        const [page, next] = await bucket.getFiles({ prefix, autoPaginate: false, maxResults: GCS_METADATA_PAGE_LIMIT,
          ...(pageToken ? { pageToken } : {}), timeoutMs: remaining() });
        remaining(); entries += page.length;
        if (entries > MAX_ENTRIES) throw new Error("GCS corpus entry limit exceeded");
        for (const file of page) {
          if (!file.name.startsWith(prefix) || file.name.length <= prefix.length || !file.name.endsWith(".md")) continue;
          if (names.has(file.name)) throw new Error("Duplicate GCS source metadata");
          names.add(file.name); files.push(file);
        }
        if (files.length > MAX_FILES) throw new Error("GCS corpus file limit exceeded");
        pageToken = next?.pageToken;
        if (pageToken !== undefined) {
          if (!pageToken || pageToken.length > GCS_METADATA_PAGE_TOKEN_LIMIT || tokens.has(pageToken)) throw new Error("Invalid GCS metadata continuation");
          tokens.add(pageToken);
          if (tokens.size >= 10 || entries >= MAX_ENTRIES) throw new Error("GCS corpus page limit exceeded");
        }
      } while (pageToken !== undefined);
      let bytes = 0, failed: unknown;
      const results = await batchMap(files, async file => {
        if (failed) throw failed;
        try {
          const [body] = await file.download({ timeoutMs: remaining() }); remaining();
          if (!Buffer.isBuffer(body)) throw new Error("Invalid GCS source body");
          bytes += body.byteLength;
          if (body.byteLength > GCS_MARKDOWN_FILE_BYTES || bytes > MAX_WORKSPACE_BYTES) throw new Error("GCS corpus byte limit exceeded");
          return { path: file.name.slice(prefix.length), body: new TextDecoder("utf-8", { fatal: true }).decode(body) };
        } catch (error) { failed = error; throw error; }
      }, { concurrency: 4 });
      const chunks: MarkdownChunk[] = [];
      for (const result of results) {
        if (!result.ok) throw result.error;
        chunks.push(...chunkMarkdown(result.value.path, result.value.body));
        if (chunks.length > MAX_CHUNKS) throw new Error("GCS corpus chunk limit exceeded");
      }
      remaining();
      const entry = { chunks, index: buildChunkIndex(chunks), loadedAt: Date.now(), bytes };
      remaining();
      while (cache.size >= CACHE_ENTRIES || cacheBytes + bytes > MAX_CACHE_BYTES) forget(cache.keys().next().value!);
      cache.set(prefix, entry); cacheBytes += bytes;
      return entry;
    });
    loading.set(prefix, promise);
    try { return await promise; } finally { if (loading.get(prefix) === promise) loading.delete(prefix); }
  };
}

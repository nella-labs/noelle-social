/** Lexical, heading-scoped Nella retrieval over complete admitted GCS workspaces. */

import type { MarkdownChunk } from "./markdownChunker.js";
import { createGcsWorkspaceLoader } from "./gcsWorkspace.js";
import { createGcsStorageReader, type GcsStorageReader } from "./gcsStorageReader.js";
import { defaultGoogleCredentialClient } from "./googleCredentials.js";
export type { GcsStorageReader } from "./gcsStorageReader.js";
import { searchResultLimit } from "./searchLimit.js";
import {
  filePathInDirs,
  scopedCandidateTopK,
  type Hit,
  type NellaClient,
} from "./nellaClient.js";

const DEFAULT_TOP_K = 8;
const SNIPPET_WINDOW = 240;
export interface CreateGcsNellaClientOptions {
  bucket: string;
  storage: GcsStorageReader;
  workspaceToPrefix?: (workspace: string) => string;
  cacheTtlMs?: number;
  timeoutMs?: number;
}

function defaultWorkspaceToPrefix(workspace: string): string {
  const slug = workspace.replace(/^mars-/, "");
  return `${slug}/`;
}

/**
 * Build a 240-char snippet window around the first occurrence of any
 * highlight term inside the chunk body. Falls back to the chunk's first
 * 240 chars when no highlight is found (e.g. score came from a stem
 * that doesn't textually appear).
 */
function snippetForChunk(
  chunk: MarkdownChunk,
  highlights: ReadonlyArray<string>,
): string {
  const body = chunk.body;
  if (!body) return "";
  const lower = body.toLowerCase();
  for (const tok of highlights) {
    if (!tok) continue;
    const idx = lower.indexOf(tok.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(body.length, start + SNIPPET_WINDOW);
      return body.slice(start, end).replace(/\s+/g, " ").trim();
    }
  }
  return body.slice(0, SNIPPET_WINDOW).replace(/\s+/g, " ").trim();
}

export function createGcsNellaClient(opts: CreateGcsNellaClientOptions): NellaClient {
  const workspaceToPrefix = opts.workspaceToPrefix ?? defaultWorkspaceToPrefix;
  const loadWorkspace = createGcsWorkspaceLoader({ ...opts, workspaceToPrefix });

  const client: NellaClient = {
    async searchContext({ workspace, query, topK = DEFAULT_TOP_K, filterDirs }) {
      topK = searchResultLimit(topK);
      if (!query.trim() || topK === 0) return [];
      const { index } = await loadWorkspace(workspace);
      // When scoping, rank a widened candidate pool then filter so we still
      // return topK hits from the allowed dirs (MiniSearch ranks-then-slices).
      const results = index.search(query, scopedCandidateTopK(topK, filterDirs));

      const hits: Hit[] = [];
      for (const { chunk, score, highlights } of results) {
        if (!filePathInDirs(chunk.filePath, filterDirs)) continue;
        hits.push({
          path: chunk.filePath,
          snippet: snippetForChunk(chunk, highlights),
          score,
          filePath: chunk.filePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          highlights: [...highlights],
        });
        if (hits.length >= topK) break;
      }
      return hits;
    },

    async getAnchors({ workspace, handle: _handle, limit = 20 }) {
      limit = searchResultLimit(limit);
      if (limit === 0) return [];
      // Surface the first `limit` chunks — matches the old "most-recent
      // markdown" semantics closely enough at v1; callers that need
      // recency-by-mtime can layer on top.
      const { chunks } = await loadWorkspace(workspace);
      return chunks.slice(0, limit).map((c) => ({
        path: c.filePath,
        content: c.body.slice(0, SNIPPET_WINDOW),
        recency: "",
        tags: [],
      }));
    },

    async ready() {
      try {
        await opts.storage.bucket(opts.bucket).getFiles({ prefix: "", autoPaginate: false, maxResults: 1 });
        return true;
      } catch {
        return false;
      }
    },
  };

  return client;
}

/** Construct the canonical bounded GCS reader with owned Google credentials. */
export async function createGcsNellaClientWithSdk(args: {
  bucket: string;
  workspaceToPrefix?: (workspace: string) => string;
  cacheTtlMs?: number;
  timeoutMs?: number;
}): Promise<NellaClient> {
  const { Storage } = await import("@google-cloud/storage");
  const sdk = new Storage({ timeout: 20_000, retryOptions: { autoRetry: false } });
  const credentials = defaultGoogleCredentialClient();
  const storage = createGcsStorageReader({ endpoint: sdk.apiEndpoint,
    getAccessToken: timeout => credentials.getAccessToken(timeout),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  });
  return createGcsNellaClient({ ...args, storage });
}

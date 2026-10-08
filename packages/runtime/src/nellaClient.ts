import { z } from "zod";
import { decodeHttpJson, fetchBoundedHttpResponse, HttpBodyError } from "./boundedHttp.js";
import { searchResultLimit } from "./searchLimit.js";

export interface Hit {
  path: string;
  snippet: string;
  score: number;
  filePath: string;
  startLine: number;
  endLine: number;
  highlights: string[];
}

export interface Anchor {
  path: string;
  content: string;
  recency: string;
  tags: string[];
}

export interface NellaClientOptions {
  baseUrl?: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * How many candidates a scoped search fetches before filtering, as a
 * multiple of the requested `topK`. We widen the pool so a dir-scoped
 * search still returns `topK` allowed hits instead of "topK-from-all then
 * filtered to a few". Capped (see `MAX_SCOPED_CANDIDATES`) to stay cheap.
 */
const SCOPED_CANDIDATE_MULTIPLIER = 5;
const MAX_SCOPED_CANDIDATES = 200;

/** Widened candidate count for a dir-scoped search; identity when unscoped. */
export function scopedCandidateTopK(topK: number, filterDirs?: string[]): number {
  topK = searchResultLimit(topK);
  if (topK === 0) return 0;
  if (!filterDirs || filterDirs.length === 0) return topK;
  return Math.min(Math.max(topK, topK * SCOPED_CANDIDATE_MULTIPLIER), MAX_SCOPED_CANDIDATES);
}

/** Normalize a dir prefix: strip leading `./` and `/`, drop a trailing `/`, lowercase. */
function normalizeDirPrefix(dir: string): string {
  return String(dir ?? "")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * True when a vault-root-relative `filePath` lives under one of `filterDirs`.
 * A prefix `foo` matches `foo/bar.md` (and the bare `foo`), but not `foobar/…`.
 * Fail-open: a malformed `filePath` or empty/absent `filterDirs` never throws —
 * empty/absent returns `true` (no scoping), malformed paths are simply excluded.
 */
export function filePathInDirs(filePath: string, filterDirs?: string[]): boolean {
  if (!filterDirs || filterDirs.length === 0) return true;
  const norm = normalizeDirPrefix(typeof filePath === "string" ? filePath : "");
  if (!norm) return false;
  for (const dir of filterDirs) {
    const prefix = normalizeDirPrefix(dir);
    if (!prefix) continue;
    if (norm === prefix || norm.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export interface NellaClient {
  searchContext(args: {
    workspace: string;
    query: string;
    topK?: number;
    mode?: "hybrid" | "semantic" | "lexical";
    filters?: { language?: string; filePattern?: string };
    /**
     * Optional vault-subdir scoping. When non-empty, only hits whose
     * vault-root-relative `filePath` starts with one of these prefixes are
     * returned (case-insensitive, `foo` matches `foo/...`). Filtering happens
     * over a widened candidate pool so a scoped search still yields `topK`
     * results from the allowed dirs. Absent/empty → unscoped (unchanged).
     */
    filterDirs?: string[];
  }): Promise<Hit[]>;

  getAnchors(args: {
    workspace: string;
    handle: string;
    limit?: number;
  }): Promise<Anchor[]>;

  ready(): Promise<boolean>;
}

export class NellaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NellaError";
  }
}

export class NellaAuthError extends NellaError {
  constructor(message: string) {
    super(message);
    this.name = "NellaAuthError";
  }
}

const ChunkSchema = z.object({
  filePath: z.string(),
  content: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
});

const SearchResultItemSchema = z.object({
  chunk: ChunkSchema,
  score: z.number(),
  highlights: z.array(z.string()).optional(),
});

const SearchResultsSchema = z.object({
  data: z.object({
    results: z.array(SearchResultItemSchema),
  }),
});

const DEFAULT_BASE = "https://nella.getnella.dev";
const DEFAULT_TIMEOUT_MS = 5000;

export function createNellaClient(opts: NellaClientOptions): NellaClient {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function call<T>(
    path: string,
    init: RequestInit,
    parseResponse: (json: unknown) => T,
  ): Promise<T> {
    let receipt: Awaited<ReturnType<typeof fetchBoundedHttpResponse>>;
    try {
      receipt = await fetchBoundedHttpResponse(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
          ...((init.headers as Record<string, string>) ?? {}),
        },
      }, { fetchImpl, timeoutMs });
    } catch (err) {
      if (err instanceof HttpBodyError) {
        if (err.status === 401 || err.status === 403) throw new NellaAuthError(`Nella auth failed (${err.status})`);
        if (err.code === "timeout") throw new NellaError(`Nella ${path} timed out after ${timeoutMs}ms`);
        throw new NellaError(`Nella ${path} response failed (${err.code})`);
      }
      throw err;
    }
    const { response: res, bytes } = receipt;
    if (res.status === 401 || res.status === 403) throw new NellaAuthError(`Nella auth failed (${res.status})`);
    if (!res.ok) throw new NellaError(`Nella ${path} returned ${res.status}`);
    try { return parseResponse(decodeHttpJson(bytes)); }
    catch (err) {
      if (err instanceof HttpBodyError) throw new NellaError(`Nella ${path} returned malformed JSON`);
      throw err;
    }
  }

  const client: NellaClient = {
    async searchContext({ workspace, query, topK = 10, mode = "hybrid", filters, filterDirs }) {
      topK = searchResultLimit(topK);
      if (topK === 0 || !query.trim()) return [];
      // Widen the fetch when scoping so client-side dir filtering still
      // yields topK allowed hits rather than topK-from-all then filtered.
      const fetchTopK = scopedCandidateTopK(topK, filterDirs);
      const data = await call(
        "/api/v1/search",
        {
          method: "POST",
          body: JSON.stringify({ workspaceId: workspace, query, mode, topK: fetchTopK, filters }),
        },
        (json) => {
          const parsed = SearchResultsSchema.safeParse(json);
          if (!parsed.success) {
            throw new NellaError("Nella returned malformed response");
          }
          return parsed.data.data;
        },
      );

      const hits = data.results.map((r) => ({
        path: r.chunk.filePath,
        snippet: r.highlights?.[0] ?? r.chunk.content.slice(0, 240),
        score: r.score,
        filePath: r.chunk.filePath,
        startLine: r.chunk.startLine,

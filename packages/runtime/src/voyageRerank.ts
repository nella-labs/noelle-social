/**
 * Voyage `rerank-2.5` reranking layer (Account Feeder, F4a — phase 1).
 *
 * Ported from Nella's `hybrid-search.ts:132-183`. Given a query and a list of
 * candidate documents, it asks Voyage's cross-encoder reranker to score each
 * document by relevance to the query and returns the documents' indices in
 * descending-score order.
 *
 * "MongoDB reranking" is a misnomer carried over from Nella: there is **no
 * MongoDB database**. `https://ai.mongodb.com/v1` is simply the hostname of
 * MongoDB's hosted Voyage gateway. We call Voyage `rerank-2.5` there.
 *
 * FAIL-OPEN IS THE LOAD-BEARING PROPERTY. If `VOYAGE_API_KEY` is unset, the
 * request errors, the response is malformed, or the call times out, this
 * module returns the *identity ranking* — the documents in their input order,
 * with descending placeholder scores — and NEVER throws. The drafter that
 * consumes this (F6) must be able to proceed on the BM25/SQL order it already
 * has; reranking is a pure quality lift, never a hard dependency. This matches
 * noelle's fail-open ethos (see docs/grounded-drafting.md: the verifier and
 * vault retrieval both fail open).
 *
 * The endpoint + key are resolved fresh on every call (credentials may rotate
 * mid-process; see secrets.md §4 — services refresh hourly, so a long-lived
 * worker must re-read env rather than capture it once).
 */

import { decodeHttpJson, fetchBoundedHttpResponse } from "./boundedHttp.js";
import { completeVoyageOrder, voyageTopK, VOYAGE_MAX_RESPONSE_BYTES } from "./voyageResponse.js";

/** A single reranked result: `index` into the input `documents` array. */
export type RerankResult = {
  /** Position of this document in the original input array. */
  index: number;
  /** Relevance score from Voyage (higher = more relevant). Placeholder scores
   * on the fail-open path are strictly descending so callers can sort safely. */
  score: number;
};

export type VoyageRerankOptions = {
  /** Return only the top-K results. Defaults to all documents. */
  topK?: number;
  /** Override `VOYAGE_API_KEY`. Falls back to env when omitted. */
  apiKey?: string;
  /** Override the gateway base URL. Falls back to `VOYAGE_ENDPOINT` env, then
   * `https://ai.mongodb.com/v1`. The `/rerank` path is appended. */
  endpoint?: string;
  /** Voyage rerank model. Default `rerank-2.5`. */
  model?: string;
  /** Caller abort signal. Combined with the internal 10s timeout — whichever
   * fires first aborts the request (and triggers the fail-open path). */
  signal?: AbortSignal;
  /** Inject a fetch implementation (testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
};

export type RankStyleExemplarsOptions = {
  /** Return only the top-K reranked candidates. Defaults to all. */
  topK?: number;
  /** Override `VOYAGE_API_KEY`. Falls back to env when omitted. */
  apiKey?: string;
  /** Override the gateway base URL. Falls back to `VOYAGE_ENDPOINT` env. */
  endpoint?: string;
  /** Caller abort signal, forwarded to the rerank call. */
  signal?: AbortSignal;
  /** Inject a fetch implementation (testing). */
  fetchImpl?: typeof fetch;
};

/** Wire shape of the Voyage `/rerank` request body. */
type VoyageRerankRequest = {
  model: string;
  query: string;
  documents: string[];
  top_k: number;
  return_documents: false;
};

/** Wire shape of the Voyage `/rerank` response we consume. */
type VoyageRerankResponse = {
  data?: Array<{ index: number; relevance_score: number }>;
};

const DEFAULT_ENDPOINT = "https://ai.mongodb.com/v1";
const DEFAULT_MODEL = "rerank-2.5";
const TIMEOUT_MS = 10_000;

/** Identity ranking: input order, strictly descending placeholder scores. */
function identityRanking(count: number, topK?: number): RerankResult[] {
  const n = topK != null ? Math.min(topK, count) : count;
  const out: RerankResult[] = [];
  for (let i = 0; i < n; i++) {
    // Descending so a sort by score preserves input order; large base keeps
    // these distinguishable from real Voyage scores (which are ~0..1).
    out.push({ index: i, score: count - i });
  }
  return out;
}

function resolveApiKey(opts?: VoyageRerankOptions): string | undefined {
  return opts?.apiKey ?? process.env["VOYAGE_API_KEY"];
}

function resolveEndpoint(opts?: VoyageRerankOptions): string {
  const base = opts?.endpoint ?? process.env["VOYAGE_ENDPOINT"] ?? DEFAULT_ENDPOINT;
  return `${base.replace(/\/$/, "")}/rerank`;
}

/**
 * Rerank `documents` against `query` with Voyage `rerank-2.5`.
 *
 * @returns documents' indices in descending relevance order (length ≤ `topK`).
 *          On ANY failure (no key, network error, non-2xx, malformed body,
 *          timeout/abort) returns the identity ranking — never throws.
 */
export async function voyageRerank(
  query: string,
  documents: string[],
  opts?: VoyageRerankOptions,
): Promise<RerankResult[]> {
  // Nothing to rank — trivially the identity ranking.
  if (documents.length === 0) return [];
  const topK = voyageTopK(documents.length, opts?.topK);
  if (topK === 0) return [];

  const apiKey = resolveApiKey(opts);
  // No key → fail open. This is the common self-host / not-yet-provisioned
  // case and must be silent (no throw, no noisy log of the missing key).
  if (!apiKey) return identityRanking(documents.length, topK);

  const url = resolveEndpoint(opts);
  const model = opts?.model ?? DEFAULT_MODEL;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const body: VoyageRerankRequest = {
    model,
    query,
    documents,
    top_k: topK,
    return_documents: false,
  };

  try {
    const { response: res, bytes } = await fetchBoundedHttpResponse(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    }, { fetchImpl, timeoutMs: TIMEOUT_MS, maxBytes: VOYAGE_MAX_RESPONSE_BYTES });

    if (!res.ok) {
      // Non-2xx (auth, rate-limit, 5xx) → fail open. Drop the body to avoid
      // logging anything that could echo the key.
      return identityRanking(documents.length, topK);
    }

    const json = decodeHttpJson(bytes) as VoyageRerankResponse;
    const data = json?.data;
    if (!Array.isArray(data) || data.length === 0) {
      // Malformed / empty payload → fail open.
      return identityRanking(documents.length, topK);
    }

    const results: RerankResult[] = [];
    const seen = new Set<number>();
    for (const r of data) {
      if (!Number.isInteger(r?.index) || r.index < 0 || r.index >= documents.length ||
        seen.has(r.index) || !Number.isFinite(r.relevance_score)) return identityRanking(documents.length, topK);
      seen.add(r.index);
      results.push({ index: r.index, score: r.relevance_score });
    }
    // If the gateway returned only junk rows, fall back rather than return [].
    if (results.length === 0) return identityRanking(documents.length, topK);

    // Voyage returns sorted; sort defensively so callers can rely on order.
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  } catch {
    // Network error, abort, timeout, JSON parse failure — all fail open.
    return identityRanking(documents.length, topK);
  }
}

/**
 * Rerank a list of style-exemplar candidates by fit to `query`, returning the
 * candidates themselves reordered (best-first).
 *
 * Thin convenience wrapper over {@link voyageRerank}: maps each candidate to
 * its text via `toText`, reranks the text, then re-projects the ranked indices
 * back onto the original candidate objects. Fails open to the input order on
 * any rerank failure (inherited from `voyageRerank` — it never throws).
 *
 * @typeParam T  the candidate type (e.g. a style exemplar / corpus row).
 */
export async function rankStyleExemplars<T>(
  query: string,
  candidates: T[],
  toText: (c: T) => string,

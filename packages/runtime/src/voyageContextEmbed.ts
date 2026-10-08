/**
 * Voyage `voyage-context-4` CONTEXTUALIZED chunk-embedding layer.
 *
 * Sibling of `voyageEmbed.ts` (`voyage-3-large`). The difference is the whole
 * point: this endpoint embeds a document's chunks *together*, so each chunk
 * vector is aware of its surrounding chunks. A chunk like "...which is why we
 * never auto-post" keeps the subject it inherited from the section above it,
 * instead of being embedded as an orphan. That is exactly what we want for the
 * KnowledgeBase, whose `markdownChunker` already splits each vault doc into
 * heading-scoped chunks (`packages/runtime/src/knowledgeBase.ts`).
 *
 * Wire shape (verified against Voyage's API reference):
 *   POST <endpoint>/contextualizedembeddings
 *   req:  { inputs: string[][], model, input_type, output_dimension }
 *         — `inputs` is an array of DOCUMENTS, each an array of its CHUNKS.
 *   res:  { data: [ { index: <docIdx>, data: [ { index: <chunkIdx>, embedding } ] } ] }
 *         — per-document grouping; `data[i].data[j].embedding` is doc i, chunk j.
 *
 * ENDPOINT NOTE: unlike `voyageEmbed`/`voyageRerank` (which default to MongoDB's
 * hosted Voyage gateway at `ai.mongodb.com`), this defaults to Voyage-DIRECT
 * (`api.voyageai.com`). The gateway is not assumed to proxy the contextualized
 * endpoint. Override via `VOYAGE_CONTEXT_ENDPOINT` (or the `endpoint` option) if
 * your gateway does support it. The key resolves `VOYAGE_CONTEXT_API_KEY` first,
 * then the shared `VOYAGE_API_KEY`, so you can point the two lanes at different
 * accounts without touching code.
 *
 * FAIL-OPEN IS THE LOAD-BEARING PROPERTY. No key, network error, non-2xx,
 * malformed/partial body, or timeout ⇒ returns `[]` and NEVER throws. Callers
 * (the KnowledgeBase dense lane) must treat `[]` as "no dense signal available"
 * and fall back to BM25-only — the dense lane is a pure quality lift, never a
 * hard dependency. This matches noelle's fail-open ethos (see voyageEmbed.ts,
 * voyageRerank.ts, docs/grounded-drafting.md).
 *
 * The endpoint + key are resolved fresh on every call (credentials may rotate
 * mid-process; see secrets.md §4 — long-lived workers must re-read env).
 */

import { decodeHttpJson, fetchBoundedHttpResponse } from "./boundedHttp.js";
import { parseVoyageEmbeddingRows, VOYAGE_MAX_RESPONSE_BYTES } from "./voyageResponse.js";

export type VoyageContextEmbedOptions = {
  /** Contextualized model. Default `voyage-context-4`. */
  model?: string;
  /** Voyage `input_type`: `document` when embedding corpus chunks, `query` when
   * embedding the search side. Default `document`. */
  inputType?: "document" | "query";
  /** Override the resolved key. Falls back to `VOYAGE_CONTEXT_API_KEY`, then
   * `VOYAGE_API_KEY`. */
  apiKey?: string;
  /** Override the base URL. Falls back to `VOYAGE_CONTEXT_ENDPOINT` env, then
   * `https://api.voyageai.com/v1`. The `/contextualizedembeddings` path is
   * appended. */
  endpoint?: string;
  /** Output vector dimension. Default 1024 (matches the `voyage-3-large` lane
   * and the existing `vector(1024)` sizing). Supported: 256, 512, 1024, 2048. */
  outputDimension?: number;
  /** Caller abort signal. Combined with the internal 10s timeout. */
  signal?: AbortSignal;
  /** Inject a fetch implementation (testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
};

/** Wire shape of the `/contextualizedembeddings` request body. */
type VoyageContextEmbedRequest = {
  inputs: string[][];
  model: string;
  input_type: "document" | "query";
  output_dimension: number;
};

/** Wire shape of the `/contextualizedembeddings` response we consume. */
type VoyageContextEmbedResponse = {
  data?: Array<{
    index: number;
    data?: Array<{ embedding: number[]; index: number }>;
  }>;
};

const DEFAULT_ENDPOINT = "https://api.voyageai.com/v1";
const DEFAULT_MODEL = "voyage-context-4";
const DEFAULT_DIMENSION = 1024;
const TIMEOUT_MS = 10_000;

function resolveApiKey(opts?: VoyageContextEmbedOptions): string | undefined {
  return (
    opts?.apiKey ??
    process.env["VOYAGE_CONTEXT_API_KEY"] ??
    process.env["VOYAGE_API_KEY"]
  );
}

function resolveEndpoint(opts?: VoyageContextEmbedOptions): string {
  const base =
    opts?.endpoint ?? process.env["VOYAGE_CONTEXT_ENDPOINT"] ?? DEFAULT_ENDPOINT;
  return `${base.replace(/\/$/, "")}/contextualizedembeddings`;
}

/** Total chunk count across all documents. */
function totalChunks(documents: string[][]): number {
  let n = 0;
  for (const doc of documents) n += doc.length;
  return n;
}

/**
 * Contextually embed `documents` (each an array of chunks) with
 * `voyage-context-4`. Returns one `number[][]` per input document — a vector
 * per chunk, in chunk order — aligned positionally to `documents`.
 *
 * @returns `documents.length` rows on success. On ANY failure (no key, network
 *          error, non-2xx, malformed body, or a doc/chunk count that doesn't
 *          match the input) returns `[]` — never throws. Empty input, or input
 *          whose documents are all empty, returns `[]` without a network call.
 */
export async function voyageContextEmbed(
  documents: string[][],
  opts?: VoyageContextEmbedOptions,
): Promise<number[][][]> {
  // Nothing to embed — trivially empty, no network call.
  if (documents.length === 0 || totalChunks(documents) === 0) return [];

  const apiKey = resolveApiKey(opts);
  // No key → fail open (return []). The common self-host / not-yet-provisioned
  // case; must be silent (no throw, no noisy log of the missing key).
  if (!apiKey) return [];

  const url = resolveEndpoint(opts);
  const model = opts?.model ?? DEFAULT_MODEL;
  const inputType = opts?.inputType ?? "document";
  const outputDimension = opts?.outputDimension ?? DEFAULT_DIMENSION;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const body: VoyageContextEmbedRequest = {
    inputs: documents,
    model,
    input_type: inputType,
    output_dimension: outputDimension,
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
      return [];
    }

    const json = decodeHttpJson(bytes) as VoyageContextEmbedResponse;
    const data = json?.data;
    if (!Array.isArray(data) || data.length === 0) {
      // Malformed / empty payload → fail open.
      return [];
    }

    // Re-project by (document index, chunk index) so callers can zip vectors
    // back onto their chunks positionally regardless of response ordering.
    const out: number[][][] = documents.map((doc) => new Array<number[]>(doc.length));
    // Empty documents (0 chunks) are trivially complete.
    const docComplete = documents.map((doc) => doc.length === 0);
    const seen = new Set<number>();

    for (const docRow of data) {
      const di = docRow?.index;
      if (!Number.isInteger(di) || di < 0 || di >= documents.length || seen.has(di)) return [];
      seen.add(di);
      const expectedChunks = documents[di]!.length;
      const chunks = parseVoyageEmbeddingRows(docRow.data, expectedChunks);
      if (!chunks) return [];
      out[di] = chunks;
      docComplete[di] = true;
    }

    // Any document not fully embedded → fail open rather than return holes.
    if (!docComplete.every(Boolean)) return [];
    return out;
  } catch {
    // Network error, abort, timeout, JSON parse failure — all fail open.
    return [];
  }
}

/**
 * Convenience: contextually embed a single query string (one one-chunk
 * document, `input_type=query`) and return its vector.
 *
 * @returns the query's embedding vector, or `[]` on a blank query or any
 *          failure (inherited from {@link voyageContextEmbed}). Never throws.
 */
export async function voyageContextEmbedQuery(
  query: string,
  opts?: Omit<VoyageContextEmbedOptions, "inputType">,
): Promise<number[]> {
  if (!query.trim()) return [];
  const out = await voyageContextEmbed([[query]], { ...opts, inputType: "query" });
  return out[0]?.[0] ?? [];
}

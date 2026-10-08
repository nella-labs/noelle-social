/**
 * Voyage `voyage-3-large` embedding layer (Account Feeder, F4b — phase 2).
 *
 * Ported from Nella's `embedder.ts:472-521` (`callVoyageAPI`). Given a batch of
 * texts, it asks Voyage's embeddings endpoint for dense vectors. The Account
 * Feeder uses these for the optional pgvector DENSE ranking layer that
 * `hybridRank.ts` RRF-fuses with the F4a rerank.
 *
 * "MongoDB" is a misnomer carried over from Nella / F4a: there is **no MongoDB
 * database**. `https://ai.mongodb.com/v1` is simply the hostname of MongoDB's
 * hosted Voyage gateway. We call Voyage `voyage-3-large` there.
 *
 * FAIL-OPEN IS THE LOAD-BEARING PROPERTY. If `VOYAGE_API_KEY` is unset, the
 * request errors, the response is malformed, or the call times out, this module
 * returns an **empty array** (`[]`) and NEVER throws. Callers must treat an
 * empty result as "no embeddings available" and fall back to the rerank-only
 * (F4a) path — the dense layer is a pure quality lift, never a hard dependency.
 * This matches noelle's fail-open ethos (see voyageRerank.ts and
 * docs/grounded-drafting.md).
 *
 * The endpoint + key are resolved fresh on every call (credentials may rotate
 * mid-process; see secrets.md §4 — services refresh hourly, so a long-lived
 * worker must re-read env rather than capture it once).
 */

import { decodeHttpJson, fetchBoundedHttpResponse } from "./boundedHttp.js";
import { parseVoyageEmbeddingRows, VOYAGE_MAX_RESPONSE_BYTES } from "./voyageResponse.js";

export type VoyageEmbedOptions = {
  /** Voyage embedding model. Default `voyage-3-large`. */
  model?: string;
  /** Voyage `input_type`: `document` when embedding corpus rows, `query` when
   * embedding the lead/query side of a search. Default `document`. */
  inputType?: "document" | "query";
  /** Override `VOYAGE_API_KEY`. Falls back to env when omitted. */
  apiKey?: string;
  /** Override the gateway base URL. Falls back to `VOYAGE_ENDPOINT` env, then
   * `https://ai.mongodb.com/v1`. The `/embeddings` path is appended. */
  endpoint?: string;
  /** Output vector dimension. Default 1024 (matches the
   * `vector(1024)` column in migration 0052). */
  outputDimension?: number;
  /** Caller abort signal. Combined with the internal 10s timeout — whichever
   * fires first aborts the request (and triggers the fail-open path). */
  signal?: AbortSignal;
  /** Inject a fetch implementation (testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
};

/** Wire shape of the Voyage `/embeddings` request body. */
type VoyageEmbedRequest = {
  input: string[];
  model: string;
  input_type: "document" | "query";
  truncation: true;
  output_dimension: number;
};

/** Wire shape of the Voyage `/embeddings` response we consume. */
type VoyageEmbedResponse = {
  data?: Array<{ embedding: number[]; index: number }>;
};

const DEFAULT_ENDPOINT = "https://ai.mongodb.com/v1";
const DEFAULT_MODEL = "voyage-3-large";
const DEFAULT_DIMENSION = 1024;
const TIMEOUT_MS = 10_000;

function resolveApiKey(opts?: VoyageEmbedOptions): string | undefined {
  return opts?.apiKey ?? process.env["VOYAGE_API_KEY"];
}

function resolveEndpoint(opts?: VoyageEmbedOptions): string {
  const base = opts?.endpoint ?? process.env["VOYAGE_ENDPOINT"] ?? DEFAULT_ENDPOINT;
  return `${base.replace(/\/$/, "")}/embeddings`;
}

/**
 * Embed `texts` with Voyage `voyage-3-large` (1024 dims by default).
 *
 * @returns one `number[]` vector per input text, in input order. On ANY failure
 *          (no key, network error, non-2xx, malformed body, timeout/abort, or a
 *          row count that doesn't match the input) returns `[]` — never throws.
 *          An empty input also returns `[]` without a network call.
 */
export async function voyageEmbed(
  texts: string[],
  opts?: VoyageEmbedOptions,
): Promise<number[][]> {
  // Nothing to embed — trivially empty, no network call.
  if (texts.length === 0) return [];

  const apiKey = resolveApiKey(opts);
  // No key → fail open (return []). The common self-host / not-yet-provisioned
  // case; must be silent (no throw, no noisy log of the missing key).
  if (!apiKey) return [];

  const url = resolveEndpoint(opts);
  const model = opts?.model ?? DEFAULT_MODEL;
  const inputType = opts?.inputType ?? "document";
  const outputDimension = opts?.outputDimension ?? DEFAULT_DIMENSION;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const body: VoyageEmbedRequest = {
    input: texts,
    model,
    input_type: inputType,
    truncation: true,
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

    const json = decodeHttpJson(bytes) as VoyageEmbedResponse;
    const data = json?.data;
    if (!Array.isArray(data) || data.length === 0) {
      // Malformed / empty payload → fail open.
      return [];
    }

    // Voyage returns rows with an `index` into the input; re-project into input
    // order so callers can zip embeddings back onto their texts positionally.
    return parseVoyageEmbeddingRows(data, texts.length) ?? [];
  } catch {
    // Network error, abort, timeout, JSON parse failure — all fail open.
    return [];
  }
}

import type { EngineBackend } from "./callAgentModel.js";
import { decodeHttpJson, fetchBoundedHttpResponse, HttpBodyError } from "./boundedHttp.js";
import { parseGeminiGeneration } from "./geminiResponse.js";

/**
 * Gemini (Google AI Studio) EngineBackend — the **bring-your-own-key** path.
 *
 * When a user pays for their own AI, they paste a Google AI Studio key
 * (`AIza…`) on the dashboard /connections page; it is stored per-org as
 * `gemini-api-key` and traffic bills *their* Google account. This backend
 * hits `generativelanguage.googleapis.com` with that key.
 *
 * The Noelle-billed default is `vertexBackend.ts` (Vertex AI via ADC, on the
 * GenAI App Builder trial credit). The classifier worker picks this backend
 * only when an org key is present, and falls back to Vertex otherwise.
 *
 * Errors throw (VertexBackend/BedrockBackend do the same) so the caller can
 * decide how to degrade — the classifier fails open to an unscored lead.
 */

export class GeminiKeyError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GeminiKeyError";
    this.status = status;
  }
}

export class GeminiKeyAuthError extends GeminiKeyError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "GeminiKeyAuthError";
  }
}

export type CreateGeminiKeyBackendOptions = {
  /** Google AI Studio key (`AIza…`). */
  apiKey: string;
  /**
   * Abstract → AI Studio model-name mapping. The catalog uses dashed
   * handles (`gemini-2-5-flash`); the API expects dotted versions
   * (`gemini-2.5-flash`).
   */
  modelIds?: Record<string, string>;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_MODEL_IDS: Record<string, string> = {
  "gemini-2-5-pro": "gemini-2.5-pro",
  "gemini-2-5-flash": "gemini-2.5-flash",
  "gemini-2-flash": "gemini-2.0-flash",
};

export type GeminiKeyBackend = EngineBackend;

export function createGeminiKeyBackend(
  opts: CreateGeminiKeyBackendOptions,
): GeminiKeyBackend {
  const apiKey = opts.apiKey;
  const modelIds = { ...DEFAULT_MODEL_IDS, ...(opts.modelIds ?? {}) };
  const maxTokens = opts.maxTokens ?? 4096;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async call(args) {
      const apiModel = modelIds[args.model] ?? args.model;
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}` +
        `:generateContent?key=${apiKey}`;
      const body = {
        systemInstruction: { parts: [{ text: args.system }] },
        contents: [{ role: "user", parts: [{ text: args.prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: maxTokens,
        },
      };

      let received: Awaited<ReturnType<typeof fetchBoundedHttpResponse>>;
      try {
        received = await fetchBoundedHttpResponse(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }, { fetchImpl, timeoutMs: args.timeoutMs ?? timeoutMs });
      } catch (err) {
        const status = err instanceof HttpBodyError ? err.status : undefined;
        const ErrorType = status === 401 || status === 403 ? GeminiKeyAuthError : GeminiKeyError;
        throw new ErrorType(`gemini call: ${err instanceof HttpBodyError ? err.message : "request failed"}`, status);
      }
      const { response: res, bytes } = received;
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new GeminiKeyAuthError(`gemini auth ${res.status}`, res.status);
        }
        throw new GeminiKeyError(`gemini ${res.status}`, res.status);
      }
      try { return parseGeminiGeneration(decodeHttpJson(bytes)); }
      catch { throw new GeminiKeyError("gemini invalid generation response", res.status); }
    },
  };
}

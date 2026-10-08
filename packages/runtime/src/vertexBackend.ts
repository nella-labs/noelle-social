import type { EngineBackend } from "./callAgentModel.js";
import { decodeHttpJson, fetchBoundedHttpResponse, HttpBodyError } from "./boundedHttp.js";
import { parseGeminiGeneration } from "./geminiResponse.js";
import { defaultGoogleCredentialClient } from "./googleCredentials.js";

/**
 * Vertex AI Gemini through the v1 REST API and Application Default Credentials.
 * Project and region options select the billing target; environment defaults
 * support deployment configuration. Generation deadlines cover HTTP dispatch
 * and the complete body. Default ADC lookup has a separate owned deadline.
 */

export class VertexError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "VertexError";
    this.status = status;
  }
}

export class VertexAuthError extends VertexError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "VertexAuthError";
  }
}

export type VertexAuthClient = {
  getAccessToken(): Promise<string | null | undefined>;
};

export type CreateVertexBackendOptions = {
  /** GCP project that owns the billable line items. Default: "noelle-agents". */
  project?: string;
  /** Vertex region. Default: "us-central1". */
  location?: string;
  /**
   * Abstract → Vertex model-name mapping. The catalog uses dashed
   * handles (`gemini-2-5-pro`) for URL/handle hygiene; Vertex's API
   * expects dotted versions (`gemini-2.5-pro`). Override per-model via
   * env (`NOELLE_VERTEX_MODEL_GEMINI_2_5_PRO` etc.) or constructor.
   */
  modelIds?: Record<string, string>;
  /** Generation cap. Default 4096 — matches bedrockBackend. */
  maxTokens?: number;
  /** Inject an auth client (testing). Otherwise google-auth-library ADC. */
  authClient?: VertexAuthClient;
  /** Default ADC operation deadline, including credential discovery. Default 8 seconds. */
  authTimeoutMs?: number;
  /** Inject a fetch implementation (testing). */
  fetchImpl?: typeof fetch;
  /** Generation request deadline, including its full response body; excludes ADC lookup. */
  timeoutMs?: number;
  /** Skip the network entirely; return a canned echo response. */
  mock?: boolean;
};

const DEFAULT_MODEL_IDS: Record<string, string> = {
  "gemini-2-5-pro": "gemini-2.5-pro",
  "gemini-2-5-flash": "gemini-2.5-flash",
  "gemini-2-flash": "gemini-2.0-flash",
};

function isMockEnabled(opts?: CreateVertexBackendOptions): boolean {
  if (opts?.mock === false) return false;
  if (opts?.mock === true) return true;
  return process.env["VERTEX_MOCK"] === "1";
}

function resolveProject(opts?: CreateVertexBackendOptions): string {
  return (
    opts?.project ??
    process.env["GOOGLE_CLOUD_PROJECT"] ??
    process.env["GCP_PROJECT"] ??
    "noelle-agents"
  );
}

function resolveLocation(opts?: CreateVertexBackendOptions): string {
  return (
    opts?.location ??
    process.env["GOOGLE_CLOUD_LOCATION"] ??
    process.env["VERTEX_LOCATION"] ??
    "us-central1"
  );
}

function resolveModelIds(opts?: CreateVertexBackendOptions): Record<string, string> {
  const merged: Record<string, string> = { ...DEFAULT_MODEL_IDS };
  const proEnv = process.env["NOELLE_VERTEX_MODEL_GEMINI_2_5_PRO"];
  if (proEnv) merged["gemini-2-5-pro"] = proEnv;
  const flashEnv = process.env["NOELLE_VERTEX_MODEL_GEMINI_2_5_FLASH"];
  if (flashEnv) merged["gemini-2-5-flash"] = flashEnv;
  if (opts?.modelIds) Object.assign(merged, opts.modelIds);
  return merged;
}

export type VertexBackend = EngineBackend;

export function createVertexBackend(opts?: CreateVertexBackendOptions): VertexBackend {
  const mock = isMockEnabled(opts);
  const project = resolveProject(opts);
  const location = resolveLocation(opts);
  const modelIds = resolveModelIds(opts);
  const maxTokens = opts?.maxTokens ?? 4096;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const explicitAuth = opts?.authClient;

  return {
    async call(args) {
      if (mock) {
        return {
          text: "[vertex-mock] " + args.prompt.slice(0, 120),
          usage: { input_tokens: args.prompt.length, output_tokens: 120 },
        };
      }

      const vertexModel = modelIds[args.model] ?? args.model;
      let token: string | null | undefined;
      try {
        token = explicitAuth ? await explicitAuth.getAccessToken()
          : await defaultGoogleCredentialClient().getAccessToken(opts?.authTimeoutMs);
      } catch {
        throw new VertexAuthError("vertex auth failed");
      }
      if (typeof token !== "string" || !token.trim()) {
        throw new VertexAuthError("vertex auth: no access token returned");
      }

      const url =
        `https://${location}-aiplatform.googleapis.com/v1/projects/${project}` +
        `/locations/${location}/publishers/google/models/${vertexModel}:generateContent`;

      const body = {
        systemInstruction: { parts: [{ text: args.system }] },
        contents: [{ role: "user", parts: [{ text: args.prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      };

      let received: Awaited<ReturnType<typeof fetchBoundedHttpResponse>>;
      try {
        received = await fetchBoundedHttpResponse(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        }, { fetchImpl, timeoutMs: args.timeoutMs ?? opts?.timeoutMs ?? 8000 });
      } catch (err) {
        const status = err instanceof HttpBodyError ? err.status : undefined;
        const ErrorType = status === 401 || status === 403 ? VertexAuthError : VertexError;
        throw new ErrorType(`vertex call: ${err instanceof HttpBodyError ? err.message : "request failed"}`, status);
      }
      const { response: res, bytes } = received;
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new VertexAuthError(`vertex auth ${res.status}`, res.status);
        }
        throw new VertexError(`vertex ${res.status}`, res.status);
      }
      try { return parseGeminiGeneration(decodeHttpJson(bytes)); }
      catch { throw new VertexError("vertex invalid generation response", res.status); }
    },
  };
}

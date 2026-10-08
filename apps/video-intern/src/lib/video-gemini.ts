import { cliTimeoutMs, createBudgetedBackend, isBudgetAdmissionError, ModelNotDispatchedError,
  parseGeminiGeneration, type EngineBackend } from "@noelle/runtime";
import { decodeHttpJson, fetchBoundedHttpResponse } from "@noelle/runtime/bounded-http";
import { defaultGoogleCredentialClient } from "@noelle/runtime/google-credentials";
import { extractVideoJson } from "./video-model-json.js";

export type VisionAuthClient = { getAccessToken(): Promise<string | null | undefined> };
export type VideoModelMetering = Parameters<typeof createBudgetedBackend>[1];
type DispatchDecision = "dispatch" | "not_dispatched";
export interface VideoModelOperation {
  readonly acknowledgement: DispatchDecision | "not_attempted" | "unknown";
  readonly markerAttempted: boolean;
  beforeDispatch(originalDeadline: number): Promise<DispatchDecision>;
}

/** Only an actual callback result acknowledges dispatch; thrown outcomes stay unknown. */
export function createVideoModelOperation(marker: () => Promise<DispatchDecision>): VideoModelOperation {
  let acknowledgement: VideoModelOperation["acknowledgement"] = "not_attempted";
  let markerAttempted = false;
  return {
    get acknowledgement() { return acknowledgement; },
    get markerAttempted() { return markerAttempted; },
    async beforeDispatch(deadline) {
      if (acknowledgement !== "not_attempted") throw new Error("Video operation was already attempted");
      if (!Number.isFinite(deadline)) throw new RangeError("Invalid Video operation deadline");
      if (performance.now() >= deadline) { acknowledgement = "not_dispatched"; return acknowledgement; }
      acknowledgement = "unknown";
      markerAttempted = true;
      const decision = await marker();
      if (decision !== "dispatch" && decision !== "not_dispatched") throw new Error("Invalid Video marker acknowledgement");
      acknowledgement = decision;
      return decision;
    },
  };
}

/** Classify undispatched work from this operation's actual acknowledgement. */
export function videoOperationFailureReason(operation: VideoModelOperation, admissionBlocked = false):
  "source_changed" | "dispatch_uncertain" | "preparation_failed" | "generation_unknown" {
  if (operation.acknowledgement === "dispatch") throw new Error("Video dispatch was acknowledged");
  if (operation.markerAttempted) return operation.acknowledgement === "not_dispatched" ? "source_changed" : "dispatch_uncertain";
  return admissionBlocked || operation.acknowledgement === "not_dispatched" ? "preparation_failed" : "generation_unknown";
}

/** Per-call options keep dispatch state out of cached resources and preserve existing hooks. */
export function videoMeteringForOperation(metering: VideoModelMetering | undefined,
  operation: VideoModelOperation | undefined, deadline: number): VideoModelMetering | undefined {
  if (!operation) return metering;
  if (!metering || metering.beforeDispatch) throw new Error("Video operation requires exclusive canonical metering");
  if (operation.acknowledgement !== "not_attempted") throw new Error("Video operation was already attempted");
  return { ...metering, beforeDispatch: () => operation.beforeDispatch(deadline) };
}
export interface VideoGeminiOptions {
  project: string;
  location?: string;
  model?: string;
  /** Canonical accounting handle when the provider uses a different model ID. */
  accountingModel?: string;
  apiKey?: string;
  authClient?: VisionAuthClient;
  fetchImpl?: typeof fetch;
  /** Overall authentication, generation and parsing budget. Default 90 seconds. */
  timeoutMs?: number;
  metering?: VideoModelMetering;
}
interface VideoGeminiRequest {
  system: string;
  parts: Array<Record<string, unknown>>;
  apiKeyParts: Array<Record<string, unknown>>;
  temperature: number;
}

/** An injected noncancellable credential seam can only return an unknown outcome. */
async function injectedToken(auth: VisionAuthClient, timeoutMs: number): Promise<string | null | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([auth.getAccessToken(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Video authentication deadline exceeded")), timeoutMs);
      timer.unref?.();
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Use the HTTP owner's signal for injected headers; its decoder still owns body cleanup. */
function injectedFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal;
    if (!signal) return fetchImpl(input, init);
    let stop: (() => void) | undefined;
    const pending = fetchImpl(input, init).then(async response => {
      if (signal.aborted) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Video request deadline exceeded");
      }
      return response;
    });
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        stop = () => reject(new Error("Video request deadline exceeded"));
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
      })]);
    } finally { if (stop) signal.removeEventListener("abort", stop); }
  };
}

/** Receive canonical text and usage before parsing the generated artifact. */
async function requestVideoGeminiGeneration(opts: VideoGeminiOptions, request: VideoGeminiRequest,
  deadline: number): ReturnType<EngineBackend["call"]> {
  const remaining = () => {
    const value = Math.ceil(deadline - performance.now());
    if (value < 1) throw new Error("Video generation deadline exceeded");
    return value;
  };
  const location = opts.location ?? "us-central1";
  const model = opts.model ?? "gemini-2.5-flash";
  let token: string | null | undefined;
  if (!opts.apiKey) {
    if (!opts.project) throw new Error("Video generation credentials unavailable");
    // Default ADC keeps its existing 8-second cap inside the overall budget.
    token = opts.authClient ? await injectedToken(opts.authClient, remaining())
      : await defaultGoogleCredentialClient().getAccessToken(Math.min(remaining(), 8000));
    if (typeof token !== "string" || !token.trim()) throw new Error("Video generation credentials unavailable");
  }
  const url = opts.apiKey
    ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${opts.apiKey}`
    : `https://${location}-aiplatform.googleapis.com/v1/projects/${opts.project}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const body = {
    ...(!opts.apiKey ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
    contents: [{ role: "user", parts: opts.apiKey ? request.apiKeyParts : request.parts }],
    generationConfig: { responseMimeType: "application/json", temperature: request.temperature },
  };
  const received = await fetchBoundedHttpResponse(url, {
    method: "POST", headers: { "content-type": "application/json", ...(!opts.apiKey ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }, { timeoutMs: remaining(), ...(opts.fetchImpl ? { fetchImpl: injectedFetch(opts.fetchImpl) } : {}) });
  if (!received.response.ok || performance.now() >= deadline) throw new Error("Video generation response unavailable");
  return parseGeminiGeneration(decodeHttpJson(received.bytes));
}

/** Shared Video request shape; admission, HTTP bytes and ADC resources use canonical owners. */
export async function requestVideoGeminiJson<T = unknown>(opts: VideoGeminiOptions, request: VideoGeminiRequest,
  validate?: (value: unknown) => T | null, operation?: VideoModelOperation, originalDeadline?: number): Promise<T | null> {
  try {
    const timeoutMs = cliTimeoutMs(opts.timeoutMs ?? 90_000);
    const deadline = Math.min(performance.now() + timeoutMs, originalDeadline ?? Infinity);
    if (!Number.isFinite(deadline)) throw new RangeError("Invalid Video generation deadline");
    if (!opts.apiKey && !opts.project) return null;
    const raw: EngineBackend = { call: () => requestVideoGeminiGeneration(opts, request, deadline) };
    const metering = videoMeteringForOperation(opts.metering, operation, deadline);
    const backend = metering ? createBudgetedBackend(raw, metering) : raw;
    const generated = await backend.call({ system: request.system, prompt: JSON.stringify(request.parts),
      model: opts.accountingModel ?? (opts.model === undefined ? "gemini-2-5-flash" : opts.model), timeoutMs });
    if (performance.now() >= deadline) return null;
    const parsed = extractVideoJson(generated.text);
    const result = validate ? validate(parsed) : parsed as T;
    return performance.now() < deadline ? result : null;
  } catch (error) {
    if (isBudgetAdmissionError(error) || error instanceof ModelNotDispatchedError) throw error;
    return null;
  }
}

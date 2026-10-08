import type { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type { EngineBackend } from "./callAgentModel.js";
import { cliTimeoutMs } from "./cliProcess.js";
import { BedrockProcess, BedrockProcessError } from "./bedrockProcess.js";
export { BedrockProcess } from "./bedrockProcess.js";
import {
  reportedAnthropicUsage,
  resolveCachedSystem,
  isCacheControlError,
  type CacheableTextBlock,
} from "./promptCache.js";

/**
 * Bedrock EngineBackend — runs Anthropic Claude on AWS Bedrock via the
 * official @anthropic-ai/bedrock-sdk client.
 *
 * The model handle passed in via callAgentModel uses Noelle's abstract
 * names (`claude-sonnet-4-6`, `claude-opus-4-6`); AWS Bedrock requires
 * cross-region inference profile IDs (e.g. `us.anthropic.claude-...`).
 * The mapping is configurable through:
 *   1. The `modelIds` constructor option (highest priority).
 *   2. Per-model env vars: NOELLE_BEDROCK_MODEL_HAIKU / _SONNET / _OPUS.
 *   3. Built-in model IDs below. Model access depends on the AWS account.
 *
 * Explicit credential pairs override the SDK's default AWS provider chain.
 * Production calls own a bounded SDK process, including credential helpers.
 *
 * Region: explicit `region` option, then AWS_REGION env, then
 * AWS_BEDROCK_REGION env, then us-east-1.
 */

export class BedrockError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "BedrockError";
    this.status = status;
  }
}

export class BedrockAuthError extends BedrockError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "BedrockAuthError";
  }
}

export type BedrockBackend = EngineBackend;

export type CreateBedrockBackendOptions = {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * Abstract → AWS Bedrock model-ID mapping. Keys are the Noelle model
   * names referenced in `EngineHandle` (e.g. "claude-sonnet-4-6"); values
   * are the corresponding AWS Bedrock invokeable model IDs.
   */
  modelIds?: Record<string, string>;
  maxTokens?: number;
  /** Whole-call deadline, including admission, credential discovery and cache fallback. Default 180s. */
  timeoutMs?: number;
  /** Replace the SDK client (testing only). */
  clientImpl?: Pick<AnthropicBedrock, "messages">;
  /** Share native admission without retaining an invocation's credential tuple. */
  processOwner?: BedrockProcess;
  mock?: boolean;
};

// AWS Bedrock model IDs for Anthropic Claude. Claude 4 family REQUIRES an
// inference profile (the `us.` prefix routes through the US cross-region
// inference profile) — invoking the raw model ID without it returns 400
// "Invocation of model ID ... with on-demand throughput isn't supported."
//
// Override per-engine via env when the account adds model access:
//   NOELLE_BEDROCK_MODEL_HAIKU=us.anthropic.claude-...
//   NOELLE_BEDROCK_MODEL_SONNET=us.anthropic.claude-...
//   NOELLE_BEDROCK_MODEL_OPUS=us.anthropic.claude-...
const DEFAULT_MODEL_IDS: Record<string, string> = {
  "claude-haiku-4-5": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6",
  "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1",
};

function isMockEnabled(opts?: CreateBedrockBackendOptions): boolean {
  if (opts?.mock === false) return false;
  if (opts?.mock === true) return true;
  return process.env["BEDROCK_MOCK"] === "1";
}

function resolveRegion(opts?: CreateBedrockBackendOptions): string {
  return (
    opts?.region ??
    process.env["AWS_REGION"] ??
    process.env["AWS_BEDROCK_REGION"] ??
    "us-east-1"
  );
}

function resolveModelIds(opts?: CreateBedrockBackendOptions): Record<string, string> {
  const merged: Record<string, string> = { ...DEFAULT_MODEL_IDS };
  if (process.env["NOELLE_BEDROCK_MODEL_HAIKU"]) {
    merged["claude-haiku-4-5"] = process.env["NOELLE_BEDROCK_MODEL_HAIKU"];
  }
  if (process.env["NOELLE_BEDROCK_MODEL_SONNET"]) {
    merged["claude-sonnet-4-6"] = process.env["NOELLE_BEDROCK_MODEL_SONNET"];
  }
  if (process.env["NOELLE_BEDROCK_MODEL_OPUS"]) {
    merged["claude-opus-4-6"] = process.env["NOELLE_BEDROCK_MODEL_OPUS"];
  }
  if (opts?.modelIds) Object.assign(merged, opts.modelIds);
  return merged;
}

function toBedrockError(err: unknown): BedrockError {
  const e = err as { status?: number; message?: string };
  const msg = err instanceof BedrockProcessError ? err.code : "failed";
  if (e?.status === 401 || e?.status === 403) {
    return new BedrockAuthError(`bedrock auth: ${msg}`, e.status);
  }
  return new BedrockError(`bedrock call: ${msg}`, e?.status);
}

export function createBedrockBackend(opts?: CreateBedrockBackendOptions): BedrockBackend {
  const mock = isMockEnabled(opts);
  const modelIds = resolveModelIds(opts);
  const maxTokens = opts?.maxTokens ?? 4096;

  const region = resolveRegion(opts);
  const processOwner = opts?.processOwner ?? new BedrockProcess();
  const configuredTimeout = process.env.NOELLE_BEDROCK_TIMEOUT_MS?.trim();
  const defaultTimeoutMs = opts?.timeoutMs ?? (configuredTimeout ? Number(configuredTimeout) : 180_000);

  return {
    async call(args) {
      if (mock) {
        return {
          text: "[bedrock-mock] " + args.prompt.slice(0, 120),
          usage: { input_tokens: args.prompt.length, output_tokens: 120 },
        };
      }

      let timeoutMs: number;
      try { timeoutMs = cliTimeoutMs(args.timeoutMs ?? defaultTimeoutMs); }
      catch { throw new BedrockError("bedrock call: invalid_request"); }
      const deadline = performance.now() + timeoutMs;

      const awsModelId = modelIds[args.model] ?? args.model;

      // Prepend any prior conversation turns (talk-to-agent chat). The caller
      // guarantees they alternate user/assistant starting with `user`, so
      // appending the new user prompt keeps the sequence valid.
      const history = (args.history ?? []).map((t) => ({
        role: t.role,
        content: t.content,
      }));

      const messages = [...history, { role: "user" as const, content: args.prompt }];
      // Prompt caching (default OFF, gated upstream in callAgentModel). When a
      // cache mechanism was requested this is a TextBlockParam[] carrying an
      // ephemeral cache_control breakpoint; otherwise it is the plain string,
      // byte-identical to before. Below the model's min cacheable size the
      // provider silently no-ops (no error). See promptCache.ts.
      const cachedSystem = resolveCachedSystem(args);
      const usedBreakpoint = Array.isArray(cachedSystem);

      const create = (system: string | CacheableTextBlock[]) => {
        if (performance.now() >= deadline) throw new BedrockProcessError("timeout");
        const body = {
          model: awsModelId,
          max_tokens: maxTokens,
          system,
          messages,
        };
        return opts?.clientImpl ? opts.clientImpl.messages.create(body) : processOwner.request({
          region, body, ...(opts?.accessKeyId && opts?.secretAccessKey ? {
            accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey,
          } : {}),
        }, deadline);
      };

      let res;
      try {
        res = await create(cachedSystem);
      } catch (err) {
        // TRUE runtime fail-open: if a model/region rejected the cache_control
        // breakpoint at call time, retry ONCE with the plain-string system so
        // the draft still succeeds (byte-identical to the no-cache path).
        if (usedBreakpoint && isCacheControlError(err)) {
          try {
            res = await create(args.system);
          } catch (retryErr) {
            throw toBedrockError(retryErr);
          }
        } else {
          throw toBedrockError(err);
        }
      }

      // The Anthropic Bedrock SDK returns the same shape as the direct API:
      // an array of content blocks, the first of which is usually `text`.
      const textBlock = res.content.find((b) => b.type === "text");
      const text = textBlock && "text" in textBlock ? textBlock.text : "";

      // Fold any cache-read/creation tokens back into the full-price input
      // count so spend is never under-counted when served from cache.
      const usage = reportedAnthropicUsage(res.usage);

      return { text, usage };
    },
  };
}

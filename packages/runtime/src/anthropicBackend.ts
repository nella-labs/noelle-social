import Anthropic from "@anthropic-ai/sdk";
import type { EngineBackend } from "./callAgentModel.js";
import {
  reportedAnthropicUsage,
  resolveCachedSystem,
  isCacheControlError,
  type CacheableTextBlock,
} from "./promptCache.js";

/**
 * Anthropic-direct EngineBackend — calls Claude through Anthropic's first-party
 * API (`@anthropic-ai/sdk`) with a plain `sk-ant-…` key. This is the
 * bring-your-own-key path for self-hosted deployments that have no GCP/AWS:
 * the operator supplies an Anthropic key and the drafter routes `engine:"claude"`
 * handles here. Structurally identical to `bedrockBackend.ts`.
 *
 * Model handles use Noelle's abstract names (`claude-sonnet-4-6`); the real
 * Anthropic model id is resolved via:
 *   1. The `modelIds` constructor option (highest priority).
 *   2. Per-model env: NOELLE_ANTHROPIC_MODEL_HAIKU / _SONNET / _OPUS.
 *   3. Built-in defaults below.
 *
 * Auth: `opts.apiKey`, else `ANTHROPIC_API_KEY` from env (SDK default).
 */

export class AnthropicError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AnthropicError";
    this.status = status;
  }
}

export class AnthropicAuthError extends AnthropicError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "AnthropicAuthError";
  }
}

export type AnthropicBackend = EngineBackend;

export type CreateAnthropicBackendOptions = {
  apiKey?: string;
  /** Abstract → Anthropic model-id mapping (e.g. "claude-sonnet-4-6" → real id). */
  modelIds?: Record<string, string>;
  maxTokens?: number;
  /** Replace the SDK client (testing only). */
  clientImpl?: Pick<Anthropic, "messages">;
  mock?: boolean;
};

const DEFAULT_MODEL_IDS: Record<string, string> = {
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-opus-4-6": "claude-opus-4-6",
};

function isMockEnabled(opts?: CreateAnthropicBackendOptions): boolean {
  if (opts?.mock === false) return false;
  if (opts?.mock === true) return true;
  return process.env["ANTHROPIC_MOCK"] === "1";
}

function resolveModelIds(opts?: CreateAnthropicBackendOptions): Record<string, string> {
  const merged: Record<string, string> = { ...DEFAULT_MODEL_IDS };
  if (process.env["NOELLE_ANTHROPIC_MODEL_HAIKU"]) {
    merged["claude-haiku-4-5"] = process.env["NOELLE_ANTHROPIC_MODEL_HAIKU"];
  }
  if (process.env["NOELLE_ANTHROPIC_MODEL_SONNET"]) {
    merged["claude-sonnet-4-6"] = process.env["NOELLE_ANTHROPIC_MODEL_SONNET"];
  }
  if (process.env["NOELLE_ANTHROPIC_MODEL_OPUS"]) {
    merged["claude-opus-4-6"] = process.env["NOELLE_ANTHROPIC_MODEL_OPUS"];
  }
  if (opts?.modelIds) Object.assign(merged, opts.modelIds);
  return merged;
}

function toAnthropicError(err: unknown): AnthropicError {
  const e = err as { status?: number; message?: string };
  const msg = e?.message ?? "unknown anthropic error";
  if (e?.status === 401 || e?.status === 403) {
    return new AnthropicAuthError(`anthropic auth: ${msg}`, e.status);
  }
  return new AnthropicError(`anthropic call: ${msg}`, e?.status);
}

export function createAnthropicBackend(
  opts?: CreateAnthropicBackendOptions,
): AnthropicBackend {
  const mock = isMockEnabled(opts);
  const modelIds = resolveModelIds(opts);
  const maxTokens = opts?.maxTokens ?? 4096;

  // Built lazily so tests (mock / clientImpl) don't need a key in env.
  const client: Pick<Anthropic, "messages"> =
    opts?.clientImpl ??
    new Anthropic(opts?.apiKey ? { apiKey: opts.apiKey } : {});

  return {
    async call(args) {
      if (mock) {
        return {
          text: "[anthropic-mock] " + args.prompt.slice(0, 120),
          usage: { input_tokens: args.prompt.length, output_tokens: 120 },
        };
      }

      const modelId = modelIds[args.model] ?? args.model;

      // Prompt caching (default OFF, gated upstream in callAgentModel). Array =
      // an ephemeral cache_control breakpoint; string = byte-identical to before.
      const cachedSystem = resolveCachedSystem(args);
      const usedBreakpoint = Array.isArray(cachedSystem);

      const create = (system: string | CacheableTextBlock[]) =>
        client.messages.create({
          model: modelId,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: args.prompt }],
        });

      let res;
      try {
        res = await create(cachedSystem);
      } catch (err) {
        // TRUE runtime fail-open: on a cache_control rejection retry ONCE with
        // the plain-string system (byte-identical to the no-cache path).
        if (usedBreakpoint && isCacheControlError(err)) {
          try {
            res = await create(args.system);
          } catch (retryErr) {
            throw toAnthropicError(retryErr);
          }
        } else {
          throw toAnthropicError(err);
        }
      }

      const textBlock = res.content.find((b) => b.type === "text");
      const text = textBlock && "text" in textBlock ? textBlock.text : "";

      // Fold any cache-read/creation tokens back into the full-price input count
      // so spend is never under-counted when served from cache.
      const usage = reportedAnthropicUsage(res.usage);

      return { text, usage };
    },
  };
}

import OpenAI from "openai";
import type { EngineBackend } from "./callAgentModel.js";
import { normalizeTokenUsage } from "./callCostAccounting.js";

/**
 * OpenAI-direct EngineBackend — calls the GPT-5 family through OpenAI's
 * first-party API (`openai` SDK) with a plain `sk-…` key. Bring-your-own-key
 * path for self-hosted deployments. Mirrors `bedrockBackend.ts` /
 * `anthropicBackend.ts`.
 *
 * Abstract model handles (`gpt-5`, `gpt-5-mini`) resolve to real OpenAI model
 * ids via `modelIds` opt, then NOELLE_OPENAI_MODEL_GPT5 / _GPT5_MINI env, then
 * identity defaults.
 *
 * Auth: `opts.apiKey`, else `OPENAI_API_KEY` from env (SDK default).
 */

export class OpenAiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "OpenAiError";
    this.status = status;
  }
}

export class OpenAiAuthError extends OpenAiError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "OpenAiAuthError";
  }
}

export type OpenAiBackend = EngineBackend;

export type CreateOpenAiBackendOptions = {
  apiKey?: string;
  modelIds?: Record<string, string>;
  maxTokens?: number;
  /** Replace the SDK client (testing only). */
  clientImpl?: Pick<OpenAI, "chat">;
  mock?: boolean;
};

const DEFAULT_MODEL_IDS: Record<string, string> = {
  "gpt-5": "gpt-5",
  "gpt-5-mini": "gpt-5-mini",
};

function isMockEnabled(opts?: CreateOpenAiBackendOptions): boolean {
  if (opts?.mock === false) return false;
  if (opts?.mock === true) return true;
  return process.env["OPENAI_MOCK"] === "1";
}

function resolveModelIds(opts?: CreateOpenAiBackendOptions): Record<string, string> {
  const merged: Record<string, string> = { ...DEFAULT_MODEL_IDS };
  if (process.env["NOELLE_OPENAI_MODEL_GPT5"]) {
    merged["gpt-5"] = process.env["NOELLE_OPENAI_MODEL_GPT5"];
  }
  if (process.env["NOELLE_OPENAI_MODEL_GPT5_MINI"]) {
    merged["gpt-5-mini"] = process.env["NOELLE_OPENAI_MODEL_GPT5_MINI"];
  }
  if (opts?.modelIds) Object.assign(merged, opts.modelIds);
  return merged;
}

export function createOpenAiBackend(
  opts?: CreateOpenAiBackendOptions,
): OpenAiBackend {
  const mock = isMockEnabled(opts);
  const modelIds = resolveModelIds(opts);
  const maxTokens = opts?.maxTokens ?? 4096;

  const client: Pick<OpenAI, "chat"> =
    opts?.clientImpl ??
    new OpenAI(opts?.apiKey ? { apiKey: opts.apiKey } : {});

  return {
    async call(args) {
      if (mock) {
        return {
          text: "[openai-mock] " + args.prompt.slice(0, 120),
          usage: { input_tokens: args.prompt.length, output_tokens: 120 },
        };
      }

      const modelId = modelIds[args.model] ?? args.model;

      let res;
      try {
        res = await client.chat.completions.create({
          model: modelId,
          max_completion_tokens: maxTokens,
          messages: [
            { role: "system", content: args.system },
            { role: "user", content: args.prompt },
          ],
        });
      } catch (err) {
        const e = err as { status?: number; message?: string };
        const msg = e?.message ?? "unknown openai error";
        if (e?.status === 401 || e?.status === 403) {
          throw new OpenAiAuthError(`openai auth: ${msg}`, e.status);
        }
        throw new OpenAiError(`openai call: ${msg}`, e?.status);
      }

      const text = res.choices?.[0]?.message?.content ?? "";

      const usage = normalizeTokenUsage(res.usage?.prompt_tokens, res.usage?.completion_tokens);

      return { text, usage };
    },
  };
}

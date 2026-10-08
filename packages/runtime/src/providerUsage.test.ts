import { describe, expect, it } from "vitest";
import { createAnthropicBackend } from "./anthropicBackend.js";
import { createBedrockBackend } from "./bedrockBackend.js";
import { createOpenAiBackend } from "./openaiBackend.js";
import { callAgentModel, unlimitedBudget } from "./callAgentModel.js";
import type { SpendRow } from "./spendRecorder.js";

function backend(engine: "claude" | "bedrock" | "openai", usage: unknown) {
  const response = engine === "openai" ? { choices: [{ message: { content: "response" } }], usage }
    : { content: [{ type: "text", text: "response" }], usage };
  const create = async () => response;
  if (engine === "claude") return createAnthropicBackend({ mock: false,
    clientImpl: { messages: { create } } as unknown as NonNullable<NonNullable<Parameters<typeof createAnthropicBackend>[0]>["clientImpl"]> });
  if (engine === "bedrock") return createBedrockBackend({ mock: false,
    clientImpl: { messages: { create } } as unknown as NonNullable<NonNullable<Parameters<typeof createBedrockBackend>[0]>["clientImpl"]> });
  return createOpenAiBackend({ mock: false,
    clientImpl: { chat: { completions: { create } } } as unknown as NonNullable<NonNullable<Parameters<typeof createOpenAiBackend>[0]>["clientImpl"]> });
}
const usage = (input: unknown, output: unknown, extra = {}) =>
  ({ input_tokens: input, output_tokens: output, prompt_tokens: input, completion_tokens: output, ...extra });

describe.each(["claude", "bedrock", "openai"] as const)("%s provider usage", (engine) => {
  const model = engine === "openai" ? "gpt-5" : "claude-haiku-4-5";
  it.each([undefined, {}, usage(1, undefined), usage("1", 2), usage(1, -2), usage(1.5, 2),
    usage(1, Number.NaN), usage(1, Number.POSITIVE_INFINITY), usage(2_147_483_648, 2)])
    ("retains absent or invalid usage as unreported: %j", async (reported) => {
      const result = await backend(engine, reported).call({ system: "system", prompt: "prompt", model });
      expect(result.text).toBe("response");
      expect(result.usage.token_usage_reported).toBe(false);
    });

  it("preserves real reported zero", async () => {
    expect((await backend(engine, usage(0, 0)).call({ system: "system", prompt: "prompt", model })).usage)
      .toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("keeps a successful missing-usage call unknown through the real routed owner", async () => {
    const rows: SpendRow[] = [];
    const result = await callAgentModel({ orgId: "org", instanceId: "instance", agentRole: "x_intern", worker: "drafter",
      bucket: "drafter", system: "system", prompt: "prompt", directRouting: true,
      routing: { primary: engine === "openai" ? { engine, model: "gpt-5" } : { engine, model: "claude-haiku-4-5" } },
    }, { engines: { [engine]: backend(engine, undefined) }, budget: unlimitedBudget,
      recorder: { record: async (row) => { rows.push(row); } } });
    expect(result.text).toBe("response");
    expect(result.usage.token_usage_reported).toBe(false);
    expect(rows).toEqual([expect.objectContaining({ status: "ok", cents: 0, costBasis: "unknown" })]);
  });
});

describe.each(["claude", "bedrock"] as const)("%s cache usage", (engine) => {
  it.each([null, -1, "3", 0.5, Number.NaN, 2_147_483_648])
    ("retains a present invalid optional cache count as unknown: %j", async (cache_read_input_tokens) => {
      const result = await backend(engine, usage(1, 2, { cache_read_input_tokens }))
        .call({ system: "system", prompt: "prompt", model: "claude-haiku-4-5" });
      expect(result.usage.token_usage_reported).toBe(false);
    });
  it("bounds the folded count to the PG integer contract", async () => {
    expect((await backend(engine, usage(2_147_483_647, 1, { cache_read_input_tokens: 1 }))
      .call({ system: "system", prompt: "prompt", model: "claude-haiku-4-5" })).usage.token_usage_reported).toBe(false);
  });
  it("folds validated cache input and permits omitted optional cache fields", async () => {
    expect((await backend(engine, usage(2, 1, { cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }))
      .call({ system: "system", prompt: "prompt", model: "claude-haiku-4-5" })).usage)
      .toEqual({ input_tokens: 9, output_tokens: 1 });
    expect((await backend(engine, usage(2, 1)).call({ system: "system", prompt: "prompt", model: "claude-haiku-4-5" })).usage)
      .toEqual({ input_tokens: 2, output_tokens: 1 });
  });
});

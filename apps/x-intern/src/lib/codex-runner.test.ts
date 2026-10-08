import { describe, expect, it, vi } from "vitest";
import { createCodexRunner } from "./codex-runner.js";

describe("codex runner", () => {
  it("forwards to callAgentModel and returns the text", async () => {
    const callAgentModel = vi.fn().mockResolvedValue({
      text: "{}",
      usage: { input_tokens: 1, output_tokens: 1 },
      engineUsed: { engine: "codex", model: "gpt-5" },
      outcome: "ok",
    });
    const runner = createCodexRunner({
      engines: {},
      budget: { adapters: {} as never, estimateCents: () => 0 },
      callAgentModel,
    } as never);
    const res = await runner.draft({
      bucket: "drafter-codex",
      orgId: "o",
      instanceId: "i",
      worker: "drafter",
      agentRole: "x_intern",
      system: "s",
      prompt: "p",
      routing: { primary: { engine: "codex", model: "gpt-5" } } as never,
    });
    expect(res.text).toBe("{}");
    expect(callAgentModel).toHaveBeenCalledTimes(1);
  });

  it("forwards worker and agentRole to callAgentModel", async () => {
    const captured: { worker?: string; agentRole?: string } = {};
    const fakeCallAgentModel = vi.fn(async (args) => {
      captured.worker = args.worker;
      captured.agentRole = args.agentRole;
      return {
        text: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
        engineUsed: { engine: "bedrock" as const, model: "claude-sonnet-4-6" as const },
        outcome: "ok" as const,
      };
    });
    const runner = createCodexRunner({
      engines: {},
      budget: {
        adapters: {
          fetchSpend: async () => ({ bucket: 0, org: 0, instance: 0 }),
          fetchCaps: async () => ({ bucket: 1e9, org: 1e9, instance: 1e9 }),
        },
      },
      callAgentModel: fakeCallAgentModel as unknown as typeof import("@noelle/runtime").callAgentModel,
    });

    await runner.draft({
      bucket: "drafter-codex",
      routing: { primary: { engine: "bedrock", model: "claude-sonnet-4-6" } },
      orgId: "org_1",
      instanceId: "inst_1",
      worker: "drafter",
      agentRole: "x_intern",
      system: "sys",
      prompt: "p",
    });

    expect(captured.worker).toBe("drafter");
    expect(captured.agentRole).toBe("x_intern");
  });

  it("forwards direct routing only when a draft explicitly requests it", async () => {
    const callAgentModel = vi.fn().mockResolvedValue({
      text: "ok",
      usage: { input_tokens: 1, output_tokens: 1 },
      engineUsed: { engine: "bedrock", model: "claude-sonnet-4-6" },
      outcome: "ok",
    });
    const runner = createCodexRunner({
      engines: {},
      budget: { adapters: {} as never, estimateCents: () => 0 },
      callAgentModel,
    } as never);
    const base = {
      bucket: "drafter-codex",
      routing: { primary: { engine: "bedrock", model: "claude-sonnet-4-6" } } as never,
      orgId: "org_1",
      instanceId: "inst_1",
      worker: "drafter",
      agentRole: "x_intern" as const,
      system: "sys",
      prompt: "p",
    };

    await runner.draft(base);
    await runner.draft({ ...base, directRouting: true });

    expect(callAgentModel.mock.calls[0]![0]).not.toHaveProperty("directRouting");
    expect(callAgentModel.mock.calls[1]![0]).toMatchObject({ directRouting: true });
  });

  it("forwards an explicit Codex-only high-reasoning request", async () => {
    const callAgentModel = vi.fn().mockResolvedValue({
      text: "ok",
      usage: { input_tokens: 1, output_tokens: 1 },
      engineUsed: { engine: "codex-cli", model: "gpt-5" },
      outcome: "ok",
    });
    const runner = createCodexRunner({
      engines: {},
      budget: { adapters: {} as never, estimateCents: () => 0 },
      callAgentModel,
    } as never);

    await runner.draft({
      bucket: "drafter-verify",
      routing: { primary: { engine: "bedrock", model: "claude-sonnet-4-6" } } as never,
      orgId: "org_1",
      instanceId: "inst_1",
      worker: "drafter",
      agentRole: "x_intern",
      system: "sys",
      prompt: "p",
      codexSubscriptionOnly: true,
      codexReasoningEffort: "high",
    });

    expect(callAgentModel).toHaveBeenCalledWith(
      expect.objectContaining({ codexSubscriptionOnly: true, codexReasoningEffort: "high" }),
      expect.anything(),
    );
  });
});

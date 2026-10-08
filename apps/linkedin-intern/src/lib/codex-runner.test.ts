import { describe, expect, it, vi } from "vitest";
import { createCodexRunner } from "./codex-runner.js";

describe("codex runner", () => {
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
      agentRole: "linkedin_intern" as const,
      system: "sys",
      prompt: "p",
    };

    await runner.draft(base);
    await runner.draft({ ...base, directRouting: true });

    expect(callAgentModel.mock.calls[0]![0]).not.toHaveProperty("directRouting");
    expect(callAgentModel.mock.calls[1]![0]).toMatchObject({ directRouting: true });
  });
});

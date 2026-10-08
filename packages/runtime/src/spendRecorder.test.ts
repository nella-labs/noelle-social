import { describe, it, expect } from "vitest";
import { noopSpendRecorder, type SpendRow } from "./spendRecorder.js";

const sampleRow: SpendRow = {
  orgId: "org_1",
  instanceId: "inst_1",
  agentRole: "x_intern",
  worker: "drafter",
  engine: "bedrock",
  model: "claude-sonnet-4-6",
  bucket: "drafter",
  inputTokens: 1234,
  outputTokens: 567,
  cents: 4,
  latencyMs: 1820,
  status: "ok",
  startedAt: new Date("2026-05-26T19:45:00Z"),
};

describe("noopSpendRecorder", () => {
  it("accepts a full SpendRow and resolves without error", async () => {
    await expect(noopSpendRecorder.record(sampleRow)).resolves.toBeUndefined();
  });

  it("accepts every status variant", async () => {
    for (const status of ["ok", "error", "timeout", "budget_exceeded"] as const) {
      await expect(
        noopSpendRecorder.record({ ...sampleRow, status }),
      ).resolves.toBeUndefined();
    }
  });
});

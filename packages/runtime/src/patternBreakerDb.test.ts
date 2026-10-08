import { expect, it, vi } from "vitest";
import {
  runPatternBreaker,
  runPatternRefine,
  type RefiningAlertRow,
  type CapturedPatternClaim,
} from "./patternBreakerDb.js";
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const item: RefiningAlertRow = {
  alert_id: "alert",
  rule_id: "rule",
  pattern_name: "stock closer",
  description: "Replies repeat a stock closer",
  current_instruction: "Avoid repeating a stock closer",
  examples: [],
  refine_note: null,
  refine_request_id: "request",
  rule_updated_at: "version",
  rule_snapshot: "fingerprint",
};
const captured: CapturedPatternClaim = {
  ...item,
  refine_request_id: "request",
  refine_claim_id: "claim",
  sourcePosts: [],
};
const posts = Array.from({ length: 4 }, (_, i) => ({
  draftId: String(i),
  body: "Useful detail with a stock closer",
  kind: "reply" as const,
  platform: "x",
}));
it("does not dispatch an analyst when active labels are unavailable", async () => {
  const call = vi.fn();
  const persist = vi.fn();
  await expect(
    runPatternBreaker({
      log,
      call,
      persist,
      loadCorpus: async () => posts,
      loadExistingLabels: async () => {
        throw Error("Unavailable");
      },
    }),
  ).rejects.toThrow("Unavailable");
  expect(call).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
});
it("does not dispatch a refinement without the current durable claim", async () => {
  const call = vi.fn();
  const applyRefined = vi.fn();
  expect(
    await runPatternRefine({
      log,
      call,
      applyRefined,
      loadQueue: async () => [item],
      claim: async () => null,
    }),
  ).toBe(0);
  expect(call).not.toHaveBeenCalled();
  expect(applyRefined).not.toHaveBeenCalled();
});
it("does not acknowledge a result rejected by the scoped write CAS", async () => {
  const call = vi
    .fn()
    .mockResolvedValue(JSON.stringify({ instruction: "Use a measured specific detail instead" }));
  const emit = vi.fn();
  expect(
    await runPatternRefine({
      log,
      call,
      loadQueue: async () => [item],
      claim: async () => captured,
      applyRefined: async () => false,
      bus: { emit } as never,
    }),
  ).toBe(0);
  expect(emit).not.toHaveBeenCalled();
});
it("passes unusable output as non-success without copying the old instruction", async () => {
  const applyRefined = vi.fn().mockResolvedValue(false);
  const emit = vi.fn();
  expect(
    await runPatternRefine({
      log,
      call: async () => "unusable",
      loadQueue: async () => [item],
      claim: async () => captured,
      applyRefined,
      bus: { emit } as never,
    }),
  ).toBe(0);
  expect(applyRefined).toHaveBeenCalledWith({ claim: captured, instruction: null });
  expect(emit).not.toHaveBeenCalled();
});
it("claims immediately before each model call rather than claiming the whole batch", async () => {
  const order: string[] = [];
  const second = { ...item, alert_id: "second" };
  await runPatternRefine({
    log,
    loadQueue: async () => [item, second],
    claim: async (item) => {
      order.push("claim:" + item.alert_id);
      return { ...captured, alert_id: item.alert_id };
    },
    call: async () => {
      order.push("call");
      return "unusable";
    },
    applyRefined: async () => false,
  });
  expect(order).toEqual(["claim:alert", "call", "claim:second", "call"]);
});
it("does not count or emit a duplicate observation rejected by the persistence owner", async () => {
  const emit = vi.fn();
  expect(
    await runPatternBreaker({
      log,
      loadCorpus: async () => posts,
      loadExistingLabels: async () => [],
      persist: async () => null,
      call: async () =>
        JSON.stringify({
          findings: [
            {
              label: "stock closer",
              kind: "phrase",
              description: "Replies repeat a stock closer",
              instruction: "Avoid repeating a stock closer",
              regex: "stock closer",
              severity: "medium",
              frequencyCount: 4,
              examples: [],
            },
          ],
        }),
      bus: { emit } as never,
    }),
  ).toBe(0);
  expect(emit).not.toHaveBeenCalled();
});

it("counts the durable observation even if event publication fails", async () => {
  expect(
    await runPatternBreaker({
      log,
      loadCorpus: async () => posts,
      loadExistingLabels: async () => [],
      persist: async () => ({ ruleId: "rule", alertId: "alert" }),
      bus: {
        emit: async () => {
          throw Error("Bus unavailable");
        },
      } as never,
      call: async () =>
        JSON.stringify({
          findings: [
            {
              label: "stock closer",
              kind: "phrase",
              description: "Replies repeat a stock closer",
              instruction: "Avoid repeating a stock closer",
              regex: "stock closer",
              severity: "medium",
              frequencyCount: 4,
              examples: [],
            },
          ],
        }),
    }),
  ).toBe(1);
});

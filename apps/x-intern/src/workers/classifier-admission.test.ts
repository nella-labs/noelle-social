import { describe, expect, it, vi } from "vitest";
import { classifyOneLead } from "./classifier-tick.js";
import { createClassifier } from "../lib/classifier-engine.js";
import { createBudgetedBackend, BudgetExceededError } from "@noelle/runtime";

const lead = {
  id: "lead",
  external_id: "post",
  author_handle: "builder",
  author_id: "author",
  status: "classifying",
  priority: false,
  tier: null,
  classifier_label: null,
  classifier_score: null,
  payload: {
    text: "We shipped a database migration tool after months of careful work",
    author_followers: 5000,
  },
};
function storage() {
  const writes: unknown[][] = [];
  const sql = Object.assign(
    vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      writes.push(values);
      return [];
    }),
    { json: (value: unknown) => value },
  );
  return { sql: sql as never, writes };
}
const unavailable = async () => ({ kind: "unavailable" as const, provider: "jev" as const });
const skip = JSON.stringify({
  on_brand: true,
  on_brand_reason: "Related but no useful reply",
  kind: "launch",
  velocity_score: 80,
  q: 10,
  reply_kind: "skip",
  tier: null,
  ai_slop: false,
});

describe("current X classifier boundary", () => {
  it("does not mark an explicit ordinary skip verdict draftable", async () => {
    const { sql, writes } = storage();
    const classifier = createClassifier({
      evaluate: unavailable,
      backend: { call: async () => ({ text: skip, usage: { input_tokens: 1, output_tokens: 1 } }) },
    });
    await classifyOneLead({
      sql,
      classifier,
      lead,
      inst: { id: "instance", org_id: "org" },
      notifier: { notify: vi.fn() },
      log: { warn: vi.fn() },
    });
    expect(writes[0]?.[0]).toBe("skipped");
  });

  it.each([false, true])(
    "current backend denies provider dispatch at cap for priority=%s",
    async (priority) => {
      const { sql, writes } = storage();
      const provider = vi.fn();
      const reserveAttempt = vi.fn(async () => {
        throw new BudgetExceededError({
          layer: "bucket",
          spent_cents: 10,
          cap_cents: 10,
          estimated_cents: 1,
        });
      });
      const backend = createBudgetedBackend(
        { call: provider },
        {
          engine: "vertex",
          context: {
            orgId: "org",
            instanceId: "instance",
            agentRole: "x_intern",
            worker: "classifier",
            bucket: "classifier",
          },
          budget: { adapters: { reserveAttempt, fetchCaps: vi.fn(), fetchSpend: vi.fn() } },
          recorder: { record: vi.fn() },
        },
      );
      const classifier = createClassifier({ backend, vipScout: true, evaluate: unavailable });
      await expect(
        classifyOneLead({
          sql,
          classifier,
          lead: { ...lead, priority },
          inst: { id: "instance", org_id: "org" },
          notifier: { notify: vi.fn() },
          log: { warn: vi.fn() },
        }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      expect(reserveAttempt).toHaveBeenCalledOnce();
      expect(provider).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    },
  );
});

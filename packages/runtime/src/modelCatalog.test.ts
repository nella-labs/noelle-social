import { describe, expect, test } from "vitest";
import {
  MODEL_CATALOG,
  catalogWinnerForModel,
  handleForModel,
} from "./modelCatalog.js";

describe("catalogWinnerForModel / handleForModel", () => {
  test("resolves a model id to one entry, preferring a wired (ready) engine", () => {
    // claude-sonnet-4-6 exists on bedrock (ready) + vertex/anthropic (preview).
    const w = catalogWinnerForModel("claude-sonnet-4-6");
    expect(w?.status).toBe("ready");
    expect(handleForModel("claude-sonnet-4-6")).toEqual({
      engine: "bedrock",
      model: "claude-sonnet-4-6",
    });
  });

  test("every catalog model id resolves to a handle", () => {
    for (const id of new Set(MODEL_CATALOG.map((m) => m.model))) {
      const h = handleForModel(id);
      expect(h, `handleForModel(${id})`).not.toBeNull();
      expect(h!.model).toBe(id);
    }
  });

  test("the resolved engine is always a real catalog (engine, model) pair", () => {
    for (const id of new Set(MODEL_CATALOG.map((m) => m.model))) {
      const h = handleForModel(id)!;
      expect(
        MODEL_CATALOG.some((m) => m.engine === h.engine && m.model === h.model),
      ).toBe(true);
    }
  });

  test("unknown model id resolves to null (never invented)", () => {
    // NOTE: gpt-5 / gpt-5-mini are now real catalog entries (OpenAI-direct
    // backend), so use ids that are genuinely not in the catalog.
    expect(catalogWinnerForModel("gpt-9-imaginary")).toBeUndefined();
    expect(handleForModel("gpt-9-imaginary")).toBeNull();
    expect(handleForModel("nope")).toBeNull();
  });
});

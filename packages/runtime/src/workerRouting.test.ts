import { describe, it, expect } from "vitest";
import { resolveWorkerRouting, WORKER_DEFAULTS } from "./workerRouting.js";

describe("resolveWorkerRouting", () => {
  it("returns null for workers that don't call LLMs", () => {
    expect(resolveWorkerRouting("discovery", null)).toBeNull();
    expect(resolveWorkerRouting("send", null)).toBeNull();
  });

  it("falls back to the hardcoded default when overrides are missing", () => {
    expect(resolveWorkerRouting("drafter", null)).toEqual(
      WORKER_DEFAULTS.drafter,
    );
    expect(resolveWorkerRouting("classifier", undefined)).toEqual(
      WORKER_DEFAULTS.classifier,
    );
  });

  it("prefers a worker-specific override over the legacy primary", () => {
    const out = resolveWorkerRouting("classifier", {
      // legacy default — should NOT win for the classifier
      primary: { engine: "bedrock", model: "claude-sonnet-4-6" },
      workers: {
        classifier: {
          primary: { engine: "bedrock", model: "claude-haiku-4-5" },
          fallback: null,
        },
      },
    });
    expect(out?.primary).toEqual({
      engine: "bedrock",
      model: "claude-haiku-4-5",
    });
    expect(out?.fallback).toBeUndefined();
  });

  it("uses the legacy primary when no per-worker override is set", () => {
    const out = resolveWorkerRouting("drafter", {
      primary: { engine: "bedrock", model: "claude-opus-4-6" },
      fallback: { engine: "bedrock", model: "claude-sonnet-4-6" },
    });
    expect(out?.primary.model).toBe("claude-opus-4-6");
    expect(out?.fallback?.model).toBe("claude-sonnet-4-6");
  });

  it("collapses preview handles to their ready substitutes via effectiveHandle", () => {
    const out = resolveWorkerRouting("drafter", {
      workers: {
        // preview — should resolve to a wired backend at call time
        drafter: {
          primary: { engine: "vertex", model: "claude-sonnet-4-6" },
        },
      },
    });
    expect(out?.primary.engine).toBe("bedrock");
    expect(out?.primary.model).toBe("claude-sonnet-4-6");
  });

  it("ignores invalid handle shapes and uses the default", () => {
    const out = resolveWorkerRouting("drafter", {
      // @ts-expect-error — intentionally malformed
      primary: { engine: "nonsense", model: 42 },
    });
    expect(out).toEqual(WORKER_DEFAULTS.drafter);
  });

  it("respects an explicit null fallback as 'fail on primary error'", () => {
    const out = resolveWorkerRouting("classifier", {
      workers: {
        classifier: {
          primary: { engine: "bedrock", model: "claude-haiku-4-5" },
          fallback: null,
        },
      },
    });
    expect(out?.primary.model).toBe("claude-haiku-4-5");
    expect(out?.fallback).toBeUndefined();
  });
});

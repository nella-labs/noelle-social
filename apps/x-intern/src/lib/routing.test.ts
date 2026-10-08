import { describe, it, expect } from "vitest";
import { xInternRouting, judgeRouting } from "./routing.js";

describe("xInternRouting", () => {
  it("uses the drafter default when there are no overrides", () => {
    const routing = xInternRouting();
    expect(routing.primary).toEqual({ engine: "bedrock", model: "claude-sonnet-4-6" });
    expect(routing.fallback).toEqual({ engine: "bedrock", model: "claude-opus-4-6" });
  });

  it("honors the per-worker drafter override (workers.drafter), not just legacy keys", () => {
    const routing = xInternRouting({
      model_overrides: {
        // Legacy top-level keys point at one model...
        primary: { engine: "bedrock", model: "claude-sonnet-4-6" },
        // ...but the drafter picker says haiku — the per-worker pick must win.
        workers: {
          drafter: { primary: { engine: "bedrock", model: "claude-haiku-4-5" } },
        },
      },
    } as never);
    expect(routing.primary).toEqual({ engine: "bedrock", model: "claude-haiku-4-5" });
  });

  it("still honors legacy top-level primary/fallback when no per-worker override", () => {
    const routing = xInternRouting({
      model_overrides: {
        primary: { engine: "bedrock", model: "claude-haiku-4-5" },
      },
    } as never);
    expect(routing.primary).toEqual({ engine: "bedrock", model: "claude-haiku-4-5" });
  });
});

describe("judgeRouting", () => {
  it("always grades on Haiku with no fallback (never the Sonnet/Opus drafter model)", () => {
    const r = judgeRouting();
    expect(r.primary).toEqual({ engine: "bedrock", model: "claude-haiku-4-5" });
    expect(r.fallback).toBeUndefined();
  });

  it("is independent of instance overrides (judge tier is not operator-tunable)", () => {
    expect(judgeRouting()).toEqual(judgeRouting());
  });
});

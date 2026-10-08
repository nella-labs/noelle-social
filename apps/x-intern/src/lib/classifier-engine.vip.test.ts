import { describe, expect, it } from "vitest";
import type { EngineBackend } from "@noelle/runtime";
import { buildClassifierSystem, createClassifier } from "./classifier-engine.js";

function stubBackend(json: string): EngineBackend {
  return {
    async call() {
      return { text: json, usage: { input_tokens: 10, output_tokens: 5 } };
    },
  } as unknown as EngineBackend;
}

describe("X classifier relationship scout", () => {
  it("omits the scout block when vipScout is off", () => {
    expect(buildClassifierSystem(null, false)).not.toContain("RELATIONSHIP SCOUT");
  });

  it("appends the scout block when vipScout is on", () => {
    const system = buildClassifierSystem("grow", true);
    expect(system).toContain("RELATIONSHIP SCOUT");
    expect(system).toContain("dm_soon");
  });

  it("does not ask the gemini scout to write the DM (Opus drafts it)", () => {
    // The DM is drafted by lib/vip-dm.ts with Opus, not by the cheap classifier
    // call — so the scout prompt must not request a suggested_dm field.
    expect(buildClassifierSystem("grow", true)).not.toContain("suggested_dm");
  });

  it("parses a relationship verdict into vip", async () => {
    const backend = stubBackend(
      JSON.stringify({
        on_brand: true,
        on_brand_reason: "builder asking a question",
        kind: "question",
        velocity_score: 60,
        tier: "T1",
        ai_slop: false,
        relationship: {
          vip: true,
          reason: "YC founder building AI devtools",
          tags: ["yc-founder"],
          add_to_watchlist: true,
          dm_soon: true,
          suggested_dm: "Saw your thread on agent loops — how do you handle retries?",
        },
      }),
    );
    const out = await createClassifier({ backend, vipScout: true }).classify({
      postText: "agent loops are hard",
      authorHandle: "janedev",
      source: "x",
      velocityAtDiscovery: 12,
      authorFollowers: 8000,
    });
    expect(out.vip?.vip).toBe(true);
    expect(out.vip?.tags).toContain("yc-founder");
  });

  it("returns vip=null when the model omits the relationship field", async () => {
    const backend = stubBackend(
      JSON.stringify({
        on_brand: true,
        on_brand_reason: "ok",
        kind: "thought",
        velocity_score: 30,
        tier: "T3",
        ai_slop: false,
      }),
    );
    const out = await createClassifier({ backend, vipScout: true }).classify({
      postText: "hi",
      authorHandle: "x",
      source: "x",
      velocityAtDiscovery: 1,
    });
    expect(out.vip).toBeNull();
  });
});

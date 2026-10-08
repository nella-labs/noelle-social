import { describe, expect, it } from "vitest";
import type { EngineBackend } from "@noelle/runtime";
import { buildClassifierSystem, createClassifier } from "./classifier-engine.js";

// A stub backend that returns a fixed JSON string and records the system prompt
// it was handed, so we can assert both the prompt wiring and the result parsing.
function stubBackend(json: string): { backend: EngineBackend; lastSystem: () => string } {
  let captured = "";
  const backend = {
    async call({ system }: { system: string }) {
      captured = system;
      return {
        text: json,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  } as unknown as EngineBackend;
  return { backend, lastSystem: () => captured };
}

describe("LinkedIn classifier relationship scout", () => {
  it("omits the scout block from the prompt when vipScout is off", () => {
    const system = buildClassifierSystem(null, 75, false);
    expect(system).not.toContain("RELATIONSHIP SCOUT");
  });

  it("appends the scout block when vipScout is on", () => {
    const system = buildClassifierSystem("grow my devtool", 75, true);
    expect(system).toContain("RELATIONSHIP SCOUT");
    expect(system).toContain("dm_soon");
  });

  it("does not ask the gemini scout to write the DM (Opus drafts it)", () => {
    // The DM is drafted by lib/vip-dm.ts with Opus, not by the cheap classifier
    // call — so the scout prompt must not request a suggested_dm field.
    expect(buildClassifierSystem("grow my devtool", 75, true)).not.toContain("suggested_dm");
  });

  it("parses a relationship verdict into vip", async () => {
    const { backend } = stubBackend(
      JSON.stringify({
        q: 92,
        reply_kind: "substantial",
        tier: "T1",
        reason: "engageable founder",
        comment_bait: false,
        relationship: {
          vip: true,
          reason: "YC W24 founder building AI devtools",
          tags: ["yc-founder", "icp"],
          add_to_watchlist: true,
          dm_soon: true,
          suggested_dm: "Loved your eval post — how are you scoring agents?",
        },
      }),
    );
    const out = await createClassifier({ backend, vipScout: true }).classify({
      postText: "how we eval agents",
      authorName: "Jane",
      authorHeadline: "Founder @ Acme (YC W24)",
    });
    expect(out.vip?.vip).toBe(true);
    expect(out.vip?.dm_soon).toBe(true);
    expect(out.vip?.suggested_dm).toContain("eval");
  });

  it("returns vip=null when the model omits the relationship field", async () => {
    const { backend } = stubBackend(
      JSON.stringify({
        q: 80,
        reply_kind: "substantial",
        tier: "T2",
        reason: "ok",
        comment_bait: false,
      }),
    );
    const out = await createClassifier({ backend, vipScout: true }).classify({
      postText: "hi",
    });
    expect(out.vip).toBeNull();
  });
});

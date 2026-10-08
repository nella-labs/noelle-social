import { describe, expect, it, vi } from "vitest";
import {
  createClassifier,
  buildClassifierSystem,
} from "./classifier-engine.js";
import { BudgetExceededError, PgOperationError, type EngineBackend } from "@noelle/runtime";

/** A stub EngineBackend that returns a fixed text + usage, recording call args. */
function stubBackend(
  text: string,
  usage: { input_tokens: number; output_tokens: number } = { input_tokens: 0, output_tokens: 0 },
): {
  backend: EngineBackend;
  calls: Array<{ system: string; prompt: string; model: string }>;
} {
  const calls: Array<{ system: string; prompt: string; model: string }> = [];
  const backend: EngineBackend = {
    call: vi.fn(async (args) => {
      calls.push({ system: args.system, prompt: args.prompt, model: args.model });
      return { text, usage };
    }),
  };
  return { backend, calls };
}

const validJson = JSON.stringify({
  on_brand: true,
  on_brand_reason: "ICP",
  kind: "question",
  velocity_score: 73,
  q: 85,
  reply_kind: "substantial",
  comment_bait: false,
  tier: "T2",
});

// The pre-reply-worthiness prompt shape: no q / reply_kind / comment_bait.
const legacyJson = JSON.stringify({
  on_brand: true,
  on_brand_reason: "ICP",
  kind: "question",
  velocity_score: 73,
  tier: "T2",
});

describe("classifier", () => {
  it("uses a confident Jev verdict without calling the legacy classifier", async () => {
    const { backend, calls } = stubBackend(validJson);
    const evaluate = async () => ({ kind: "choice" as const, choice: "skip", probability: 0.93, probabilities: { skip: 0.93 }, provider: "jev" as const });
    const out = await createClassifier({ backend, evaluate, vipScout: false }).classify({ postText: "Buy my course", authorHandle: "seller", source: "x", velocityAtDiscovery: 0 });
    expect(out.reply_kind).toBe("skip");
    expect(out.on_brand).toBe(false);
    expect(out.raw).toMatchObject({ judge: "jev" });
    expect(calls).toHaveLength(0);
  });

  it("keeps relationship scouting while Jev decides reply quality", async () => {
    const { backend, calls } = stubBackend(JSON.stringify({ ...JSON.parse(validJson), relationship: { vip: true, reason: "Founder", tags: ["founder"], add_to_watchlist: true, dm_soon: false } }));
    const evaluate = async () => ({ kind: "choice" as const, choice: "skip", probability: 0.91, probabilities: { skip: 0.91 }, provider: "jev" as const });
    const out = await createClassifier({ backend, evaluate, vipScout: true }).classify({ postText: "Buy my course", authorHandle: "seller", source: "x", velocityAtDiscovery: 0 });
    expect(out.reply_kind).toBe("skip");
    expect(out.vip?.vip).toBe(true);
    expect(calls).toHaveLength(1);
  });
  it("parses a clean JSON response from the backend", async () => {
    const { backend } = stubBackend(validJson);
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "looking for help with AI agents", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(out.on_brand).toBe(true);
    expect(out.velocity_score).toBe(73);
    // Reply-worthiness is a SEPARATE signal from the velocity proxy.
    expect(out.q).toBe(85);
    expect(out.reply_kind).toBe("substantial");
    expect(out.comment_bait).toBe(false);
    // Tier is recomputed from q, never trusted from the model: q=85 → T2.
    expect(out.tier).toBe("T2");
  });

  it("derives the tier from q rather than trusting the model's tier", async () => {
    // Model says T1; q=62 says T3. The band wins, so a model that mis-tiers a
    // lead cannot escalate it to the smarter/costlier drafter path.
    const { backend } = stubBackend(
      JSON.stringify({ on_brand: true, on_brand_reason: "r", kind: "question", velocity_score: 10, q: 62, reply_kind: "substantial", tier: "T1" }),
    );
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(out.tier).toBe("T3");
  });

  it("gives a LIGHT lead no tier (a short warm reply never escalates)", async () => {
    const { backend } = stubBackend(
      JSON.stringify({ on_brand: true, on_brand_reason: "r", kind: "launch", velocity_score: 40, q: 55, reply_kind: "light", tier: "T1" }),
    );
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "we shipped!", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(out.reply_kind).toBe("light");
    expect(out.tier).toBeNull();
  });

  it("forces reply_kind=skip when the post is off-brand or AI slop", async () => {
    for (const extra of [{ on_brand: false }, { ai_slop: true }]) {
      const { backend } = stubBackend(
        JSON.stringify({ on_brand: true, on_brand_reason: "r", kind: "thought", velocity_score: 50, q: 90, reply_kind: "substantial", ...extra }),
      );
      const c = createClassifier({ backend });
      const out = await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
      expect(out.reply_kind).toBe("skip");
      expect(out.tier).toBeNull();
    }
  });

  it("falls back to velocity_score for q on the legacy prompt shape", async () => {
    const { backend } = stubBackend(legacyJson);
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(out.q).toBe(73);
    expect(out.reply_kind).toBe("substantial");
    expect(out.comment_bait).toBe(false);
  });

  it("parses a fenced ```json response (Vertex prose wrapping)", async () => {
    const { backend } = stubBackend("```json\n" + validJson + "\n```");
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(out.velocity_score).toBe(73);
    expect(out.kind).toBe("question");
  });

  it("fails open with a NULL score (not 0) when the backend throws", async () => {
    const backend: EngineBackend = {
      call: vi.fn(async () => {
        throw new Error("vertex 500");
      }),
    };
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "anything", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(out.on_brand).toBe(true);
    expect(out.velocity_score).toBeNull();
    expect(out.on_brand_reason).toContain("fail-open");
  });

  it("fails open with a NULL score when the response is not JSON", async () => {
    const { backend } = stubBackend("I'm sorry, I can't do that.");
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(out.velocity_score).toBeNull();
  });

  it("forces off-brand when the LLM flags ai_slop, even if it said on_brand=true", async () => {
    const slopJson = JSON.stringify({
      on_brand: true,
      on_brand_reason: "looked relevant",
      kind: "launch",
      velocity_score: 50,
      tier: "T2",
      ai_slop: true,
      ai_slop_reason: "emoji bullets + hype",
    });
    const { backend } = stubBackend(slopJson);
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(out.ai_slop).toBe(true);
    expect(out.on_brand).toBe(false);
  });

  it("defaults ai_slop=false when the response omits it", async () => {
    const { backend } = stubBackend(validJson);
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(out.ai_slop).toBe(false);
    expect(out.ai_slop_reason).toBeNull();
    expect(out.on_brand).toBe(true);
  });

  it("serialises authorFollowers into the backend prompt and explains the follower floor", async () => {
    const { backend, calls } = stubBackend(validJson);
    const c = createClassifier({ backend });
    await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0, authorFollowers: 1234 });
    expect(calls[0]?.prompt).toContain("1234");
    expect(calls[0]?.system).toContain("FOLLOWERS");
  });

  it("passes the operator objective and model into the backend call", async () => {
    const { backend, calls } = stubBackend(validJson);
    const c = createClassifier({ backend, objective: "find AI eval-tooling buyers", model: "gemini-2-5-pro" });
    await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(calls[0]?.system).toContain("find AI eval-tooling buyers");
    expect(calls[0]?.model).toBe("gemini-2-5-pro");
  });

  it("defaults to the Vertex Gemini Flash handle", async () => {
    const { backend, calls } = stubBackend(validJson);
    const c = createClassifier({ backend });
    await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(calls[0]?.model).toBe("gemini-2-5-flash");
  });

  it("surfaces token usage from the backend call", async () => {
    const { backend } = stubBackend(validJson, { input_tokens: 412, output_tokens: 37 });
    const c = createClassifier({ backend });

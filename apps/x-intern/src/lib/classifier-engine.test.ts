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
    const out = await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(out.usage).toEqual({ inputTokens: 412, outputTokens: 37 });
  });

  it("still carries usage on a post-call fail-open (unparseable response cost tokens)", async () => {
    const { backend } = stubBackend("not json", { input_tokens: 300, output_tokens: 5 });
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(out.velocity_score).toBeNull();
    expect(out.usage).toEqual({ inputTokens: 300, outputTokens: 5 });
  });

  it("reports zero usage when the backend call throws (no metered response)", async () => {
    const backend: EngineBackend = {
      call: vi.fn(async () => {
        throw new Error("vertex 500");
      }),
    };
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p", authorHandle: "u", source: "x", velocityAtDiscovery: 0 });
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("buildClassifierSystem", () => {
  it("returns the base triage prompt with no custom objective", () => {
    const base = buildClassifierSystem();
    expect(base).toContain("triage X posts");
    expect(base.toLowerCase()).not.toContain("founder's mission");
  });

  it("weaves the mission into the triage definition", () => {
    const out = buildClassifierSystem("target LLM eval tooling buyers");
    expect(out).toContain("triage X posts");
    expect(out).toContain("target LLM eval tooling buyers");
  });
});

describe("classifyMany (batched classification)", () => {
  const input = (postText: string) => ({
    postText,
    authorHandle: "someone",
    source: "x" as const,
    velocityAtDiscovery: 0,
    authorFollowers: 100,
  });
  const verdict = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    on_brand: true,
    on_brand_reason: "ICP",
    kind: "question",
    velocity_score: 73,
    q: 85,
    reply_kind: "substantial",
    comment_bait: false,
    ...extra,
  });

  it("uses confident Jev decisions for the whole batch without a legacy call", async () => {
    const { backend, calls } = stubBackend("[]");
    const evaluate = async () => ({ kind: "choice" as const, choice: "substantial", probability: 0.9, probabilities: { substantial: 0.9 }, provider: "jev" as const });
    const result = await createClassifier({ backend, evaluate, vipScout: false }).classifyMany([input("a"), input("b")]);
    expect(result.verdicts.map((v) => v?.reply_kind)).toEqual(["substantial", "substantial"]);
    expect(result.verdicts.map((v) => (v?.raw as Record<string, unknown>)?.judge)).toEqual(["jev", "jev"]);
    expect(calls).toHaveLength(0);
  });

  it("batches only uncertain Jev entries through the legacy classifier", async () => {
    const { backend, calls } = stubBackend(JSON.stringify([verdict(0, { kind: "legacy-middle" })]));
    const decisions = [
      { kind: "choice" as const, choice: "skip", probability: 0.95, probabilities: { substantial: 0.02, light: 0.03, skip: 0.95 }, provider: "jev" as const },
      { kind: "unavailable" as const, provider: "jev" as const },
      { kind: "choice" as const, choice: "light", probability: 0.9, probabilities: { substantial: 0.04, light: 0.9, skip: 0.06 }, provider: "jev" as const },
    ];
    const evaluate = async () => decisions.shift()!;
    const result = await createClassifier({ backend, evaluate, vipScout: false }).classifyMany([input("a"), input("b"), input("c")]);
    expect(result.verdicts.map((v) => v?.reply_kind)).toEqual(["skip", "substantial", "light"]);
    expect(result.verdicts[1]?.kind).toBe("legacy-middle");
    expect(JSON.parse(calls[0]!.prompt)).toEqual([expect.objectContaining({ id: 0, postText: "b" })]);
  });

  it("sends ONE call for the whole batch and ids every lead", async () => {
    const { backend, calls } = stubBackend(JSON.stringify([verdict(0), verdict(1), verdict(2)]));
    const c = createClassifier({ backend });
    const res = await c.classifyMany([input("a"), input("b"), input("c")]);
    expect(backend.call).toHaveBeenCalledTimes(1);
    expect(res.verdicts.filter(Boolean)).toHaveLength(3);
    // The batch instruction must reach the model, or it answers with one object.
    expect(calls[0]!.system).toContain("BATCH MODE");
    const sent = JSON.parse(calls[0]!.prompt) as Array<{ id: number; postText: string }>;
    expect(sent.map((s) => s.id)).toEqual([0, 1, 2]);
    expect(sent.map((s) => s.postText)).toEqual(["a", "b", "c"]);
  });

  it("maps by the echoed id, not array position", async () => {
    // A model that reorders must not shift every verdict onto the wrong lead.
    const { backend } = stubBackend(
      JSON.stringify([verdict(2, { kind: "third" }), verdict(0, { kind: "first" }), verdict(1, { kind: "second" })]),
    );
    const c = createClassifier({ backend });
    const res = await c.classifyMany([input("a"), input("b"), input("c")]);
    expect(res.verdicts.map((v) => v?.kind)).toEqual(["first", "second", "third"]);
  });

  it("returns null for a lead the batch dropped, so the caller can fall back", async () => {
    const { backend } = stubBackend(JSON.stringify([verdict(0), verdict(2)]));
    const c = createClassifier({ backend });
    const res = await c.classifyMany([input("a"), input("b"), input("c")]);
    expect(res.verdicts[0]).not.toBeNull();
    expect(res.verdicts[1]).toBeNull();
    expect(res.verdicts[2]).not.toBeNull();
  });

  it("drops only the entry that fails the schema", async () => {
    const { backend } = stubBackend(
      JSON.stringify([verdict(0), { id: 1, on_brand: "yes please" }, verdict(2)]),
    );
    const c = createClassifier({ backend });
    const res = await c.classifyMany([input("a"), input("b"), input("c")]);
    expect(res.verdicts.map((v) => v !== null)).toEqual([true, false, true]);
  });

  it("ignores an out-of-range or duplicate id rather than mis-assigning it", async () => {
    const { backend } = stubBackend(
      JSON.stringify([verdict(0, { kind: "keep" }), verdict(0, { kind: "dupe" }), verdict(9)]),
    );
    const c = createClassifier({ backend });
    const res = await c.classifyMany([input("a"), input("b")]);
    expect(res.verdicts[0]?.kind).toBe("keep");
    expect(res.verdicts[1]).toBeNull();
  });

  it("reports usage for an unparseable batch — the call still spent tokens", async () => {
    const { backend } = stubBackend("sorry, no JSON here", {
      input_tokens: 4000,
      output_tokens: 90,
    });
    const c = createClassifier({ backend });
    const res = await c.classifyMany([input("a"), input("b")]);
    expect(res.verdicts).toEqual([null, null]);
    expect(res.usage).toEqual({ inputTokens: 4000, outputTokens: 90 });
  });

  it("carries usage ONCE on the batch, never on the verdicts", async () => {
    // The caller records the batch row; per-verdict usage would count it N times.
    const { backend } = stubBackend(JSON.stringify([verdict(0), verdict(1)]), {
      input_tokens: 9529,
      output_tokens: 2274,
    });
    const c = createClassifier({ backend });
    const res = await c.classifyMany([input("a"), input("b")]);
    expect(res.usage).toEqual({ inputTokens: 9529, outputTokens: 2274 });
    for (const v of res.verdicts) {
      expect(v?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    }
  });

  it("normalises a batched verdict exactly like a solo one", async () => {
    // ai_slop forces off_brand and a skip, and the tier is recomputed from q —
    // the batched path must not skip those rules.
    const { backend } = stubBackend(JSON.stringify([verdict(0, { ai_slop: true })]));
    const c = createClassifier({ backend });
    const res = await c.classifyMany([input("a")]);
    expect(res.verdicts[0]?.on_brand).toBe(false);
    expect(res.verdicts[0]?.reply_kind).toBe("skip");
    expect(res.verdicts[0]?.tier).toBeNull();
  });

  it("makes no call for an empty batch", async () => {
    const { backend } = stubBackend("[]");
    const c = createClassifier({ backend });
    const res = await c.classifyMany([]);
    expect(backend.call).not.toHaveBeenCalled();
    expect(res).toEqual({ verdicts: [], usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it("falls back for every lead when the call throws", async () => {
    const backend: EngineBackend = { call: vi.fn(async () => { throw new Error("boom"); }) };
    const c = createClassifier({ backend });
    const res = await c.classifyMany([input("a"), input("b")]);
    expect(res.verdicts).toEqual([null, null]);
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("budget admission failures", () => {
  it.each([
    new BudgetExceededError({ layer: "instance", spent_cents: 8, cap_cents: 10, estimated_cents: 8 }),
    new PgOperationError("deadline"),
  ])("does not turn %s into a legacy fail-open verdict", async (error) => {
    const call = vi.fn().mockRejectedValue(error);
    const classifier = createClassifier({ backend: { call }, evaluate: async () => ({ kind: "unavailable", provider: "jev" }) });
    await expect(classifier.classify({ postText: "specific engineering question", authorHandle: "author", source: "x" as const, velocityAtDiscovery: 0 })).rejects.toBe(error);
    expect(call).toHaveBeenCalledOnce();
  });
  it("stops batch fallback on a rejected admission", async () => {
    const error = new PgOperationError("database");
    const call = vi.fn().mockRejectedValue(error);
    const classifier = createClassifier({ backend: { call }, evaluate: async () => ({ kind: "unavailable", provider: "jev" }) });
    await expect(classifier.classifyMany([{ postText: "question", authorHandle: "author", source: "x", velocityAtDiscovery: 0 }])).rejects.toBe(error);
    expect(call).toHaveBeenCalledOnce();
  });
});

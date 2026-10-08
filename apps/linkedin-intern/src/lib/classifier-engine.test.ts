import { describe, expect, it, vi } from "vitest";
import {
  createClassifier,
  buildClassifierSystem,
  tierForQ,
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

const substantialJson = JSON.stringify({
  q: 92,
  reply_kind: "substantial",
  tier: "T1",
  reason: "founder sharing a real technical pain",
});

describe("tierForQ", () => {
  it("maps q to tier bands (>=90 T1, 80-89 T2, else T3)", () => {
    expect(tierForQ(95)).toBe("T1");
    expect(tierForQ(90)).toBe("T1");
    expect(tierForQ(89)).toBe("T2");
    expect(tierForQ(80)).toBe("T2");
    expect(tierForQ(79)).toBe("T3");
    expect(tierForQ(75)).toBe("T3");
  });
});

describe("classifier", () => {
  it("parses a clean substantial JSON response and recomputes tier from q", async () => {
    const { backend } = stubBackend(substantialJson);
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "we keep losing context across long agent sessions", authorName: "Jane", authorHeadline: "Founder" });
    expect(out.reply_kind).toBe("substantial");
    expect(out.q).toBe(92);
    expect(out.tier).toBe("T1");
  });

  it("recomputes the tier band from q even if the model picked the wrong band", async () => {
    // q=82 → T2 band, but the model said T1. We trust the band.
    const { backend } = stubBackend(JSON.stringify({ q: 82, reply_kind: "substantial", tier: "T1", reason: "x" }));
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p" });
    expect(out.tier).toBe("T2");
  });

  it("forces tier=null for a light lead", async () => {
    const { backend } = stubBackend(JSON.stringify({ q: 60, reply_kind: "light", tier: "T2", reason: "launch win" }));
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "we just shipped v1!" });
    expect(out.reply_kind).toBe("light");
    expect(out.tier).toBeNull();
  });

  it("forces tier=null for a skip lead", async () => {
    const { backend } = stubBackend(JSON.stringify({ q: 10, reply_kind: "skip", tier: null, reason: "job promo" }));
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "We are hiring 5 engineers!" });
    expect(out.reply_kind).toBe("skip");
    expect(out.tier).toBeNull();
  });

  it("parses a fenced ```json response (Vertex prose wrapping)", async () => {
    const { backend } = stubBackend("```json\n" + substantialJson + "\n```");
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p" });
    expect(out.q).toBe(92);
    expect(out.reply_kind).toBe("substantial");
  });

  it("fails OPEN to substantial/T3 with a NULL score when the backend throws", async () => {
    const backend: EngineBackend = {
      call: vi.fn(async () => {
        throw new Error("vertex 500");
      }),
    };
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "anything" });
    // Nothing high-signal is silently lost — fail open as a substantial T3.
    expect(out.reply_kind).toBe("substantial");
    expect(out.tier).toBe("T3");
    expect(out.q).toBeNull();
    expect(out.reason).toContain("fail-open");
  });

  it("fails open with a NULL score when the response is not JSON", async () => {
    const { backend } = stubBackend("I'm sorry, I can't do that.");
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p" });
    expect(out.q).toBeNull();
    expect(out.reply_kind).toBe("substantial");
  });

  it("fails open when the JSON is missing required fields (schema miss)", async () => {
    const { backend } = stubBackend(JSON.stringify({ q: 50 })); // no reply_kind / reason
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p" });
    expect(out.q).toBeNull();
    expect(out.reason).toContain("fail-open");
  });

  it("serialises the author name/headline into the backend prompt", async () => {
    const { backend, calls } = stubBackend(substantialJson);
    const c = createClassifier({ backend });
    await c.classify({ postText: "p", authorName: "Jane Builder", authorHeadline: "Founder @ Acme" });
    expect(calls[0]?.prompt).toContain("Jane Builder");
    expect(calls[0]?.prompt).toContain("Founder @ Acme");
  });

  it("passes the operator objective, threshold, and model into the backend call", async () => {
    const { backend, calls } = stubBackend(substantialJson);
    const c = createClassifier({ backend, objective: "find AI eval-tooling buyers", model: "gemini-2-5-pro", qThreshold: 80 });
    await c.classify({ postText: "p" });
    expect(calls[0]?.system).toContain("find AI eval-tooling buyers");
    expect(calls[0]?.system).toContain("q >= 80");
    expect(calls[0]?.model).toBe("gemini-2-5-pro");
  });

  it("defaults to the Vertex Gemini Flash handle", async () => {
    const { backend, calls } = stubBackend(substantialJson);
    const c = createClassifier({ backend });
    await c.classify({ postText: "p" });
    expect(calls[0]?.model).toBe("gemini-2-5-flash");
  });

  it("emits comment_bait=true when the model flags an engagement-bait post", async () => {
    const { backend } = stubBackend(
      JSON.stringify({ q: 70, reply_kind: "light", tier: null, comment_bait: true, reason: "comment-to-enter giveaway" }),
    );
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "Comment 'AI' below to get my free guide!" });
    expect(out.comment_bait).toBe(true);
  });

  it("emits comment_bait=false for a normal post", async () => {
    const { backend } = stubBackend(substantialJson); // no comment_bait field → defaults false
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p" });
    expect(out.comment_bait).toBe(false);
  });

  it("defaults comment_bait=false on a fail-open (never demotes a real post off a scoring failure)", async () => {
    const backend: EngineBackend = {
      call: vi.fn(async () => {
        throw new Error("vertex 500");
      }),
    };
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "anything" });
    expect(out.comment_bait).toBe(false);
  });

  it("asks for comment_bait in the system prompt", () => {
    const sys = buildClassifierSystem();
    expect(sys).toContain("comment_bait");
    expect(sys.toLowerCase()).toContain("engagement-bait");
  });

  it("surfaces token usage from the backend call", async () => {
    const { backend } = stubBackend(substantialJson, { input_tokens: 412, output_tokens: 37 });
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p" });
    expect(out.usage).toEqual({ inputTokens: 412, outputTokens: 37 });
  });

  it("still carries usage on a post-call fail-open (unparseable response cost tokens)", async () => {
    const { backend } = stubBackend("not json", { input_tokens: 300, output_tokens: 5 });
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p" });
    expect(out.q).toBeNull();
    expect(out.usage).toEqual({ inputTokens: 300, outputTokens: 5 });
  });

  it("reports zero usage when the backend call throws (no metered response)", async () => {
    const backend: EngineBackend = {
      call: vi.fn(async () => {
        throw new Error("vertex 500");
      }),
    };
    const c = createClassifier({ backend });
    const out = await c.classify({ postText: "p" });
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

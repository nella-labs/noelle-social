import { describe, expect, it } from "vitest";
import type { VideoScriptOutput } from "@noelle/contracts";
import { BudgetExceededError } from "@noelle/runtime";
import { PgOperationError } from "@noelle/runtime/bounded-pg-session";
import { verifyScript, flattenScriptText, verdictScore } from "./script-verify.js";
import { sanitizeScriptOutput } from "./video-generate.js";
import type { JsonFn } from "./video-generate.js";

function script(over: Partial<VideoScriptOutput> = {}): VideoScriptOutput {
  return {
    hook: "The one thing nobody tells you about shipping fast",
    structure: [
      { tStart: 0, tEnd: 3, purpose: "hook", line: "You do not need a perfect plan." },
      { tStart: 3, tEnd: 8, purpose: "payoff", line: "You need to ship, then fix what breaks." },
    ],
    script: "You do not need a perfect plan. You need to ship, then fix what breaks.",
    transitions: [{ at: "0", type: "cut" }],
    sounds: [{ name: "lofi beat", trending: false }],
    graphSpecs: [],
    ...over,
  };
}

const ctx = { objective: "grow the audience", hook: "shipping fast", concept: "ship then fix", voiceAnchors: ["I ship rough and iterate in public."] };
const goodJudge: JsonFn = async () => ({ voice: 0.9, grounding: 0.9, relevance: 0.9, reasons: [], fix: null });

describe("flattenScriptText", () => {
  it("uses the full script body plus on-screen titles", () => {
    const text = flattenScriptText(script({ graphSpecs: [{ kind: "kinetic_text", title: "SHIP IT" }] }));
    expect(text).toContain("perfect plan");
    expect(text).toContain("SHIP IT");
  });

  it("falls back to hook + beat lines when the full script is empty", () => {
    const text = flattenScriptText(script({ script: "" }));
    expect(text).toContain("nobody tells you");
    expect(text).toContain("perfect plan");
  });
});

describe("verifyScript", () => {
  it("uses confident Jev decisions for each semantic dimension", async () => {
    const evaluate = async () => ({ kind: "confident" as const, pass: true, probability: 0.92, provider: "jev" as const });
    const v = await verifyScript(script(), ctx, async () => { throw new Error("legacy judge must not run"); }, { evaluate });
    expect(v.pass).toBe(true);
    expect(v.scores).toMatchObject({ voice: 0.92, grounding: 0.92, relevance: 0.92 });
    expect(v.judge).toBe("jev");
  });

  it("falls back to the current judge when any Jev dimension is uncertain", async () => {
    const decisions = [
      { kind: "confident" as const, pass: true, probability: 0.92, provider: "jev" as const },
      { kind: "uncertain" as const, probability: 0.56, provider: "jev" as const },
    ];
    const evaluate = async () => decisions.shift()!;
    const v = await verifyScript(script(), ctx, goodJudge, { evaluate });
    expect(v.scores).toMatchObject({ voice: 0.9, grounding: 0.9, relevance: 0.9 });
    expect(v.judge).toBe("legacy");
  });

  it("does not treat unavailable Jev and a broken legacy judge as a genuine review", async () => {
    const evaluate = async () => ({ kind: "unavailable" as const, provider: "jev" as const });
    const v = await verifyScript(script(), ctx, async () => null, { evaluate });
    expect(v.judge).toBe("unavailable");
    expect(v.pass).toBe(false);
  });
  it.each([
    new BudgetExceededError({ layer: "instance", spent_cents: 1, cap_cents: 1, estimated_cents: 1 }),
    new PgOperationError("database"),
  ])("propagates rejected fallback admission %s instead of returning a verdict", async error => {
    const evaluate = async () => ({ kind: "unavailable" as const, provider: "jev" as const });
    await expect(verifyScript(script(), ctx, async () => { throw error; }, { evaluate })).rejects.toBe(error);
  });
  it("passes a clean script when the judge scores high", async () => {
    const v = await verifyScript(script(), ctx, goodJudge);
    expect(v.pass).toBe(true);
    expect(v.scores).toMatchObject({ voice: 0.9, grounding: 0.9, relevance: 0.9, format: 1 });
  });

  it("hard-zeros format and fails when a script contains an em dash", async () => {
    const v = await verifyScript(script({ script: "Ship fast — then fix it." }), ctx, goodJudge);
    expect(v.scores.format).toBe(0);
    expect(v.pass).toBe(false);
    expect(v.fix).toMatch(/em dash/i);
  });

  it("fails below the voice floor and surfaces the judge fix", async () => {
    const weakJudge: JsonFn = async () => ({ voice: 0.4, grounding: 0.9, relevance: 0.9, reasons: ["reads generic"], fix: "sound more like the operator" });
    const v = await verifyScript(script(), ctx, weakJudge, { voiceFloor: 0.65 });
    expect(v.pass).toBe(false);
    expect(v.fix).toContain("sound more like the operator");
  });

  it("hard-zeros format on a confirmed Pattern Breaker phrase rule (Lyra parity)", async () => {
    const rules = [{ kind: "phrase" as const, label: "pet phrase", instruction: "stop saying 'game changer'", regex: "game changer", source: "manual" as const }];
    const v = await verifyScript(
      script({ script: "This tool is a game changer for founders." }),
      { ...ctx, patternRules: rules },
      goodJudge,
    );
    expect(v.scores.format).toBe(0);
    expect(v.pass).toBe(false);
  });

  it("fails review when both Jev and the legacy judge are unavailable", async () => {
    const v = await verifyScript(script(), ctx, async () => null);
    expect(v.scores).toMatchObject({ voice: 0, grounding: 0, relevance: 0 });
    expect(v.pass).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/judge unavailable/i);
  });

  it("passes structure guidance to Nova's script judge", async () => {
    let seenSystem = "";
    let seenPrompt = "";
    await verifyScript(script(), ctx, async (_system, _user) => {
      seenSystem = _system;
      seenPrompt = _user;
      return { voice: 0.9, grounding: 0.9, relevance: 0.9, reasons: [], fix: null };
    });

    expect(seenSystem).toContain("Let the content earn its ending");
    expect(seenSystem).toContain("supported by the supplied facts");
    expect(seenSystem).toContain("preserve the script's purpose and meaning");
    expect(seenPrompt).toContain("CONTENT AND STRUCTURE");
  });
});

describe("verdictScore", () => {
  it("averages the four dimensions", () => {
    expect(verdictScore({ scores: { voice: 1, grounding: 1, relevance: 1, format: 0 } })).toBeCloseTo(0.75);
  });
});

describe("sanitizeScriptOutput", () => {
  it("strips em/en dashes and double hyphens from every string field", () => {
    const dirty = script({
      hook: "Do both — badly first",
      script: "Ship it — then fix — the rest",
      structure: [{ tStart: 0, tEnd: 3, purpose: "the turn — honest", line: "here is the thing -- nobody says it" }],
      graphSpecs: [{ kind: "kinetic_text", title: "0% — understood", note: "fade — in", data: [{ label: "before — after", value: 1 }] }],
    });
    const clean = sanitizeScriptOutput(dirty);
    const all = flattenScriptText(clean) + " " + clean.structure[0]!.purpose + " " + JSON.stringify(clean.graphSpecs);
    expect(all).not.toMatch(/[—–―]|--/);
    expect(clean.hook).toBe("Do both, badly first");
  });
});

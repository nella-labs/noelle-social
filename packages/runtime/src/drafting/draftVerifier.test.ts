import { describe, expect, it, vi } from "vitest";
import type { JevRun } from "../jev.js";
import {
  replyDiversityScore,
  scoreFormat,
  verifyDrafts,
  verifyTiered,
  type DraftToVerify,
  type VerifyContext,
} from "./draftVerifier.js";

const reply = (body: string): DraftToVerify => ({ kind: "reply", angle: "empathetic", body });
const ctx: VerifyContext = {
  platform: "x",
  postText: "shipping a rust cli is painful",
  authorHandle: "u",
  voiceAnchors: ["i ship small and often, yep that is the whole ritual"],
  charLimit: 250,
};

const goodJudge = () =>
  Promise.resolve(JSON.stringify({ voice: 0.9, grounding: 0.9, relevance: 0.9, reasons: [], fix: null }));
const badJudge = () =>
  Promise.resolve(JSON.stringify({ voice: 0.3, grounding: 0.4, relevance: 0.5, reasons: ["too generic"], fix: "be specific about rust build times" }));

describe("scoreFormat", () => {
  it.each(["so real!", "so true.", "so good!!"])("accepts an entire brief reaction: %s", (body) => {
    expect(scoreFormat(reply(body), 250).score).toBe(1);
    expect(scoreFormat({ kind: "dm", angle: null, body }, undefined, true, true).score).toBe(1);
    expect(scoreFormat(reply(`the retry loop is fixed, ${body}`), 250).score).toBe(0);
  });

  it.each(["x", "linkedin", "reddit"] as const)("scopes the short-reaction reviewer guidance on %s", async (platform) => {
    const judge = vi.fn<(system: string, prompt: string) => Promise<string>>(goodJudge);
    await verifyDrafts([reply("so real")], { ...ctx, platform }, judge);
    const prompt = String(judge.mock.calls[0]?.[1]);
    expect(prompt.includes("Do not require unique nouns or an added explanation")).toBe(platform === "x");
  });

  it("scores a clean short reply 1.0", () => {
    const f = scoreFormat(reply("rust build times are brutal, what worked for me was sccache"), 250);
    expect(f.score).toBe(1);
    expect(f.reasons).toHaveLength(0);
  });

  it("penalizes em dashes", () => {
    const f = scoreFormat(reply("rust is great — but slow"), 250);
    expect(f.score).toBeLessThan(1);
    expect(f.reasons.join(" ")).toContain("em dash");
  });

  it("penalizes over-length bodies", () => {
    const f = scoreFormat(reply("x".repeat(400)), 250);
    expect(f.score).toBeLessThan(1);
    expect(f.reasons.join(" ")).toContain("over length");
  });

  it("flags choppy fragment. fragment. style", () => {
    const f = scoreFormat(reply("Yes. True. So real. Big if. Wow now."), 250);
    expect(f.reasons.join(" ")).toContain("choppy");
  });

  it("HARD-ZEROES a repeated/garbled sentence (e.g. 'you want me to mass. you want me to mass.')", () => {
    const post: DraftToVerify = {
      kind: "repost",
      angle: null,
      body: "the offer comes in and it is like... you want me to mass. you want me to mass. hunger goes both ways.",
    };
    const f = scoreFormat(post);
    expect(f.score).toBe(0);
    expect(f.reasons.join(" ")).toContain("repeated");
  });

  it("HARD-ZEROES an immediately-repeated phrase within a line", () => {
    const f = scoreFormat(reply("if you want someone to bet on you bet on you, do it back"));
    expect(f.score).toBe(0);
  });

  it("HARD-ZEROES generic tacked-on closers ('Congrats on shipping it.', 'love this')", () => {
    expect(scoreFormat(reply("Privacy-first storage is a smart call here. Congrats on shipping it.")).score).toBe(0);
    expect(scoreFormat(reply("the offline-first bet is the right one. love this")).score).toBe(0);
    expect(scoreFormat(reply("excited to see where this goes")).score).toBe(0);
  });

  it("allowCelebration exempts warm win-reactions (LIGHT path) but keeps other slop banned", () => {
    // A LIGHT reply IS a congrats on a launch — these must pass when allowed.
    expect(scoreFormat(reply("congrats on the launch, the demo looked sharp"), undefined, true).score).toBe(1);
    expect(scoreFormat(reply("the offline-first bet is the right one. love this"), undefined, true).score).toBe(1);
    expect(scoreFormat(reply("this is huge!"), undefined, true).score).toBe(1);
    // ...but the exemption does NOT relax the rest (insight-bait, filler, em dash).
    expect(scoreFormat(reply("the gap between strategy and execution is where most stall"), undefined, true).score).toBe(0);
    expect(scoreFormat(reply("nice, curious to hear how it lands"), undefined, true).score).toBe(0);
    // ...and the SAME congrats is still a hard zero on the substantial path (default).
    expect(scoreFormat(reply("congrats on the launch, the demo looked sharp")).score).toBe(0);
  });

  it("HARD-ZEROES a learned 'phrase' rule from the Pattern Breaker (dynamic regex)", () => {
    // No source (back-compat) and operator-confirmed sources stay a hard zero.
    const dyn = [
      { kind: "phrase" as const, label: "big-if-true tic", instruction: "stop ending posts with 'big if true'", regex: "big if true" },
    ];
    expect(scoreFormat(reply("the offline-first bet is the right one big if true"), undefined, false, false, dyn).score).toBe(0);
    // a clean draft is untouched by the dynamic rule
    expect(scoreFormat(reply("the offline-first bet is the right one for this team"), undefined, false, false, dyn).score).toBe(1);
    // an operator-confirmed (refined/manual) rule is also a hard zero
    const confirmed = [{ ...dyn[0]!, source: "manual" as const }];
    expect(scoreFormat(reply("the offline-first bet is the right one big if true"), undefined, false, false, confirmed).score).toBe(0);
  });

  it("SOFTENS an AUTO-detected phrase rule to a nudge (occasional reuse OK, no forever-ban)", () => {
    const dyn = [
      { kind: "phrase" as const, source: "auto" as const, label: "big-if-true tic", instruction: "stop reaching for 'big if true'", regex: "big if true" },
    ];
    // A single auto hit on an otherwise-clean reply is penalized but still clears
    // the 0.7 bar — the operator wanted variety nudges, not a hard ban.
    const one = scoreFormat(reply("the offline-first bet is the right one big if true"), undefined, false, false, dyn);
    expect(one.score).toBeGreaterThan(0);
    expect(one.score).toBeCloseTo(0.7);
    expect(one.reasons.join(" ")).toContain("vary it");
    // A clean draft is untouched.
    expect(scoreFormat(reply("the offline-first bet is the right one for this team"), undefined, false, false, dyn).score).toBe(1);
  });

  it("does not let auto terminal-punctuation rules contradict the public no-full-stops rule", () => {
    const droppedPeriod = [
      { kind: "phrase" as const, source: "auto" as const, label: "Dropped terminal punctuation",
        instruction: "Do not habitually leave replies without terminal punctuation.", regex: "[A-Za-z0-9]$" },
      { kind: "phrase" as const, source: "auto" as const, label: "Dropped terminal punctuation",
        instruction: "Do not routinely leave declarative replies hanging without terminal punctuation.", regex: "[^.!?\\s]\\s*$" },
    ];
    const body = "A profile visit may warm up the next conversation";
    const publicReply = scoreFormat(reply(body), undefined, false, true, droppedPeriod);
    expect(publicReply.score).toBe(1);
    expect(publicReply.reasons).toEqual([]);
    expect(scoreFormat({ kind: "dm", angle: null, body }, undefined, false, true, droppedPeriod).score).toBeLessThan(1);
    expect(scoreFormat(reply(body), undefined, false, true,
      [{ ...droppedPeriod[0]!, source: "manual" }]).score).toBe(0);
  });

  it("only penalizes a lowercase opener when the learned rule explicitly asks for lowercase", () => {
    const lowercaseOpener = [{
      kind: "phrase" as const,
      source: "auto" as const,
      label: "lowercase opener",
      instruction: "Vary a lowercase first word",
      regex: "^[a-z]",
    }];
    const body = "My read: maintenance needs an owner after the initial build.";
    expect(scoreFormat(reply(body), undefined, false, false, lowercaseOpener).score).toBe(1);
    expect(scoreFormat(reply(`m${body.slice(1)}`), undefined, false, false, lowercaseOpener).score).toBeCloseTo(0.7);

    const ordinaryPhrase = [{ ...lowercaseOpener[0]!, regex: "maintenance" }];
    expect(scoreFormat(reply(body), undefined, false, false, ordinaryPhrase).score).toBeCloseTo(0.7);

    const compound = [{ ...lowercaseOpener[0]!, regex: "^[a-z].*maintenance" }];
    expect(scoreFormat(reply(body), undefined, false, false, compound).score).toBe(1);
    expect(scoreFormat(reply("my read: Maintenance needs an owner."), undefined, false, false, compound).score).toBeCloseTo(0.7);
  });

  it("ignores a learned rule whose regex does not compile (never crashes)", () => {
    const dyn = [{ kind: "phrase" as const, label: "broken", instruction: "x", regex: "(unclosed" }];
    expect(() => scoreFormat(reply("totally normal text here"), undefined, false, false, dyn)).not.toThrow();
    expect(scoreFormat(reply("totally normal text here"), undefined, false, false, dyn).score).toBe(1);
  });

  it("does NOT flag a clean post with distinct lines", () => {
    const post: DraftToVerify = {
      kind: "repost",
      angle: null,
      body: "Everyone wants hungry people. Nobody pays them like it. The mismatch costs you the exact builders you claim to want.",
    };
    expect(scoreFormat(post).score).toBeGreaterThan(0.4);
  });

  it("em dash is a HARD ZERO (not a partial penalty)", () => {
    const f = scoreFormat(reply("rust is great — but slow"), 250);
    expect(f.score).toBe(0);
  });

  it("named slop phrases are a HARD ZERO and the reason names them", () => {
    for (const [body, needle] of [
      ["this hits different honestly", "hits different"],
      ["the gap between strategy and execution is where most orgs stall", "gap between"],
      ["nice work, curious to hear how it lands", "curious to hear"],
      ["even with a great resume you still have to babysit it", "babysit"],
    ] as const) {
      const f = scoreFormat(reply(body), 250);
      expect(f.score).toBe(0);
      expect(f.reasons.join(" ").toLowerCase()).toContain(needle);
    }
  });

  it("HARD-ZEROES lazy referential filler + the 'slaps' tic (operator ban)", () => {
    for (const [body, needle] of [
      ["the part where you scoped it down is the smart move", "part where"],
      ["loved the stuff about pricing", "the stuff"],
      ["basically the stuff you shipped, or the stuff you cut", "the stuff"],
      ["something of the post really stuck with me", "something of"],
      ["this slaps, going to steal the approach", "slaps"],
    ] as const) {
      const f = scoreFormat(reply(body), 250);
      expect(f.score).toBe(0);
      expect(f.reasons.join(" ").toLowerCase()).toContain(needle);
    }
  });

  it("does NOT flag clean, specific replies that avoid the filler patterns", () => {
    for (const body of [
      "scoping it to one workflow first is the smart move",
      "the pricing tiers you shipped map cleanly to the ICP",
      "stealing your onboarding checklist idea for our flow",
    ]) {
      expect(scoreFormat(reply(body), 250).score).toBe(1);
    }
  });

  // 'honestly' is a SOFT penalty, not a hard zero (operator decision). The prompt
  // has always allowed one natural "honestly" as texture; this check used to
  // hard-zero every occurrence, and across 1646 live drafts 71% of the drafts it
  // killed were the mid-sentence usage the prompt explicitly permits.
  it("penalizes ONE 'honestly' but still lets it clear the bar (strictVoice)", () => {
    const f = scoreFormat(reply("honestly this explains a lot about why carousels win"), 250, false, true);
    expect(f.score).toBeCloseTo(0.7);
    expect(f.score).toBeGreaterThanOrEqual(0.7); // the pass threshold
    expect(f.reasons.join(" ").toLowerCase()).toContain("honestly");
  });

  it("STACKS the penalty so leaning on 'honestly' drops below the bar", () => {
    const f = scoreFormat(reply("honestly the docs are rough, and honestly nobody reads them"), 250, false, true);
    expect(f.score).toBeCloseTo(0.4);
    expect(f.score).toBeLessThan(0.7);
    expect(f.reasons.join(" ")).toContain("2x");
  });

  it("one 'honestly' plus any other tell drops below the bar", () => {
    // The soft penalty must not become a free pass when combined with real slop.
    const f = scoreFormat(reply("honestly the offline-first bet is right, curious to hear how it lands"), 250, false, true);
    expect(f.score).toBeLessThan(0.7);
  });

  it("the honestly penalty is NOT relaxed on the celebration path", () => {
    // congrats / "this is huge!" are celebration-exempt, but the filler tic is not.
    const f = scoreFormat(reply("honestly congrats, this is huge!"), undefined, true, true);
    expect(f.score).toBeLessThan(1);
    expect(f.reasons.join(" ").toLowerCase()).toContain("honestly");
  });

  it("honestly is ALLOWED when banFiller is off (e.g. X keeps it as intentional filler)", () => {
    expect(scoreFormat(reply("honestly i swapped in mold and my link step halved"), 250).score).toBe(1);
  });

  it("a clean celebration reply with no honestly still passes on the celebration path", () => {
    expect(scoreFormat(reply("congrats, this is huge!"), undefined, true).score).toBe(1);
  });

  it("fails the actual slop draft from the inbox (gap-between + curious-to-hear)", () => {
    const f = scoreFormat(
      reply(
        "That panel framing is sharp, Hassan. The gap between strategy deck and actual execution is where most orgs quietly stall out. Curious to hear how the conversation lands.",
      ),
      400,
    );
    expect(f.score).toBe(0);
  });

  it("a clean conversational reply still scores 1.0 (no false positives)", () => {
    const f = scoreFormat(
      reply("yeah the rollout cadence is the hard part, what worked for us was shipping behind a flag and dialing it up slowly"),
      400,
    );
    expect(f.score).toBe(1);
    expect(f.reasons).toHaveLength(0);
  });
});

describe("scoreFormat — contrastive-reframe crutch ('not X, it's Y' / 'is X, not Y')", () => {
  const post = (body: string): DraftToVerify => ({ kind: "repost", angle: null, body });

  it("flags the operator's real examples so they fail the pass bar and regenerate", () => {
    for (const body of [
      "raising $8M isn't a win, it's a countdown timer", // negate → re-assert
      "being outside the scene is a filter, not a handicap", // affirm → negate tail
      "the real work in growth is the deciding, not the doing", // affirm → negate tail
    ]) {
      const f = scoreFormat(post(body));
      expect(f.score).toBeLessThan(0.7);
      expect(f.reasons.join(" ").toLowerCase()).toContain("contrastive-reframe");
    }
  });

  it("applies to replies too, not just posts", () => {
    const f = scoreFormat(reply("shipping isn't the hard part, it's the deciding"), 250);
    expect(f.score).toBeLessThan(0.7);
  });

  it("penalizes a single lean to exactly the base penalty (not a hard zero — rare use can survive best-of-set)", () => {
    const f = scoreFormat(post("being outside the scene is a filter, not a handicap"));
    expect(f.score).toBeCloseTo(0.5); // 1 - REFRAME_BASE_PENALTY
    expect(f.score).toBeGreaterThan(0);
  });

  it("drives a STACK of reframes toward zero", () => {
    // two distinct patterns: 'isn't … it's' + ', not a …'
    const f = scoreFormat(post("this isn't a setback, it's a filter, not a handicap"));
    expect(f.score).toBeLessThan(0.2);
  });

  it("does NOT flag ordinary either/or phrasing or plain negation (no false positives)", () => {
    for (const body of [
      "shipping behind a flag and dialing it up slowly worked for us",
      "i'm not sure this holds up under real load yet",
      "ping me whenever you get a sec, no rush at all",
      "we cut the build time in half with sccache and a warm cache",
      "the pricing tiers you shipped map cleanly to the ICP",
    ]) {
      const f = scoreFormat(post(body));
      expect(f.score).toBe(1);
      expect(f.reasons).toHaveLength(0);
    }
  });

  it("via verifyDrafts: a reframe draft fails format even when the judge passes", async () => {
    const v = await verifyDrafts([post("raising $8M isn't a win, it's a countdown timer")], ctx, goodJudge);
    expect(v.pass).toBe(false);
    expect(v.scores.format).toBeLessThan(0.7);
    expect(v.fix?.toLowerCase()).toContain("contrastive-reframe");
  });
});

describe("verifyDrafts", () => {
  it("passes when the judge scores high and format is clean", async () => {
    const v = await verifyDrafts([reply("sccache cut my rust builds in half, worth a look")], ctx, goodJudge);
    expect(v.pass).toBe(true);
    expect(v.scores.voice).toBeGreaterThanOrEqual(0.6);
    expect(v.fix).toBeNull();
  });

  it("fails when the judge scores below threshold and surfaces the fix", async () => {
    const v = await verifyDrafts([reply("great take, love this")], ctx, badJudge);
    expect(v.pass).toBe(false);
    expect(v.fix).toContain("rust build times");
    expect(v.scores.grounding).toBeCloseTo(0.4);
  });

  it("fails on a format violation even when the judge passes", async () => {
    const v = await verifyDrafts([reply("solid point — " + "x".repeat(300))], ctx, goodJudge);
    expect(v.pass).toBe(false);
    expect(v.scores.format).toBeLessThan(0.6);
    expect(v.reasons.join(" ")).toMatch(/em dash|over length/);
  });

  it("fails open (passes) when the judge throws", async () => {
    const v = await verifyDrafts([reply("a clean grounded reply")], ctx, () => Promise.reject(new Error("503")));
    expect(v.pass).toBe(true);
    expect(v.reasons.join(" ")).toContain("passed open");
  });

  it("fails open when the judge returns unparseable output", async () => {
    const v = await verifyDrafts([reply("a clean grounded reply")], ctx, () => Promise.resolve("I think it's fine!"));
    expect(v.pass).toBe(true);
    expect(v.reasons.join(" ")).toContain("passed open");
  });

  it("passes a charLimit through to the format check", async () => {
    const v = await verifyDrafts([reply("x".repeat(200))], { ...ctx, charLimit: 150 }, goodJudge);
    expect(v.scores.format).toBeLessThan(1);
  });

  it("folds an imageCaption into the judge prompt (and omits it when absent)", async () => {
    let withImg = "";
    await verifyDrafts(
      [reply("clean grounded reply")],
      { ...ctx, imageCaption: "a bar chart showing 3x revenue growth" },
      (_system, prompt) => {
        withImg = prompt;
        return goodJudge();
      },
    );
    expect(withImg).toContain("THE POST'S IMAGE SHOWS:");
    expect(withImg).toContain("a bar chart showing 3x revenue growth");

    let noImg = "";
    await verifyDrafts([reply("clean grounded reply")], ctx, (_system, prompt) => {
      noImg = prompt;
      return goodJudge();
    });
    expect(noImg).not.toContain("THE POST'S IMAGE SHOWS:");
  });

  it("treats a pinned faithful voice as the authoritative voice target", async () => {
    let seenPrompt = "";

    await verifyDrafts(
      [reply("clean grounded reply")],
      {
        ...ctx,
        faithfulVoiceAnchors: [
          "@eliana_jordan: this is kind of ridiculous (I love it)",
          "Voice notes: warm, playful, lowercase",
        ],

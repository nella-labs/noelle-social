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
      },
      (_system, prompt) => {
        seenPrompt = prompt;
        return goodJudge();
      },
    );

    expect(seenPrompt).toContain("PINNED FAITHFUL VOICE TARGET");
    expect(seenPrompt).toContain("authoritative for the voice score");
    expect(seenPrompt).toContain("@eliana_jordan: this is kind of ridiculous (I love it)");
    expect(seenPrompt).toContain("secondary voice evidence");
  });

  it("passes structure guidance and bounded recent-feed context to the judge", async () => {
    const recent = Array.from({ length: 25 }, (_, i) =>
      i === 0 ? "event happened, therefore everyone should learn the same lesson".repeat(20) : `recent reply ${i}`,
    );
    let seenSystem = "";
    let seenPrompt = "";

    await verifyDrafts([reply("this deserves a different move")], { ...ctx, recentReplies: recent }, (system, prompt) => {
      seenSystem = system;
      seenPrompt = prompt;
      return goodJudge();
    });

    expect(seenSystem).toContain("0.7 is the passing bar");
    expect(seenSystem).toContain("Let the content earn its ending");
    expect(seenSystem).toContain("Do not invent a moral, personal realization, emotion, number, or sensory detail");
    expect(seenPrompt).toContain("RECENT REPLIES ACROSS THE FEED");
    expect(seenPrompt).toContain("public reply drafts");
    expect(seenPrompt).toContain("repeated sequence of ideas and endings");
    expect(seenPrompt.match(/\[\d+\] recent reply/g) ?? []).toHaveLength(19);
    expect(seenPrompt).not.toContain("recent reply 20");
    expect(seenPrompt).toContain("…");
  });

  it("does not show unrelated feed-wide reply history to DM-only or repost-only judge calls", async () => {
    const dm: DraftToVerify = { kind: "dm", angle: null, body: "worth comparing notes on this rollout" };
    const repost: DraftToVerify = { kind: "repost", angle: null, body: "shipping notes from this week" };

    for (const draft of [dm, repost]) {
      let seenPrompt = "";
      await verifyDrafts([draft], { ...ctx, recentReplies: ["recent public reply shape"] }, (_system, prompt) => {
        seenPrompt = prompt;
        return goodJudge();
      });

      expect(seenPrompt).not.toContain("RECENT REPLIES ACROSS THE FEED");
      expect(seenPrompt).not.toContain("recent public reply shape");
    }
  });

});

describe("original post verifier prompt", () => {
  it("grades original posts against the requested premise, not as replies to an original post", async () => {
    const post = {
      kind: "post",
      angle: null,
      body: "Useful DMs start with something you actually noticed.",
    } as DraftToVerify;
    let seenSystem = "";
    let seenPrompt = "";

    await verifyDrafts([post], ctx, (system, prompt) => {
      seenSystem = system;
      seenPrompt = prompt;
      return goodJudge();
    });

    expect(seenSystem).toContain("draft original social posts");
    expect(seenSystem).toContain("requested premise");
    expect(seenSystem).not.toContain("draft social replies");
    const groundingRule = seenSystem.split("\n").find((line) => line.startsWith("- grounding:"));
    expect(groundingRule).not.toContain("voice anchors");
    expect(seenSystem).toContain("Voice anchors are tone examples only, never factual support");
    expect(seenPrompt).toContain("POST PREMISE / REQUESTED IDEA:");
    expect(seenPrompt).not.toContain("ORIGINAL POST");
    expect(seenPrompt).toContain("[post]");
  });

  it("keeps reply verifier prompts unchanged", async () => {
    let seenSystem = "";
    let seenPrompt = "";

    await verifyDrafts([reply("rust build times are brutal")], ctx, (system, prompt) => {
      seenSystem = system;
      seenPrompt = prompt;
      return goodJudge();
    });

    expect(seenSystem).toContain("draft social replies");
    expect(seenPrompt).toContain("ORIGINAL POST by @u:");
  });
});

describe("verifyTiered", () => {
  it("with one judge behaves like verifyDrafts", async () => {
    const v = await verifyTiered([reply("grounded and specific")], ctx, [goodJudge]);
    expect(v.pass).toBe(true);
  });

  it("majority of 3 judges decides pass", async () => {
    const v = await verifyTiered([reply("grounded and specific")], ctx, [goodJudge, goodJudge, badJudge]);
    expect(v.pass).toBe(true); // 2 pass, 1 fail → pass
  });

  it("majority of 3 judges decides fail and takes the strictest fix", async () => {
    const v = await verifyTiered([reply("meh generic")], ctx, [badJudge, badJudge, goodJudge]);
    expect(v.pass).toBe(false); // 2 fail, 1 pass → fail
    expect(v.fix).toContain("rust build times");
  });

  it("uses the median score across judges", async () => {
    const mid = () => Promise.resolve(JSON.stringify({ voice: 0.7, grounding: 0.7, relevance: 0.7, reasons: [], fix: null }));
    const v = await verifyTiered([reply("ok")], ctx, [badJudge, mid, goodJudge]);
    // medians of {0.3,0.7,0.9}=0.7 voice; {0.4,0.7,0.9}=0.7 grounding; {0.5,0.7,0.9}=0.7
    expect(v.scores.voice).toBeCloseTo(0.7);
    expect(v.scores.grounding).toBeCloseTo(0.7);
    expect(v.scores.relevance).toBeCloseTo(0.7);
  });

  it("runs judges in parallel", async () => {
    const calls: number[] = [];
    const slow = (n: number) => () => new Promise<string>((res) => {
      calls.push(n);
      res(JSON.stringify({ voice: 0.9, grounding: 0.9, relevance: 0.9, reasons: [], fix: null }));
    });
    await verifyTiered([reply("x")], ctx, [slow(1), slow(2), slow(3)]);
    expect(calls).toHaveLength(3);
  });
});

describe("per-person novelty (repetition vs prior replies to this person)", () => {
  const cleanFour = JSON.stringify({ voice: 0.9, grounding: 0.9, relevance: 0.9, novelty: 0.9, reasons: [], fix: null });

  it("FAILS a draft the judge marks redundant vs prior replies to this person", async () => {
    const judge = () =>
      Promise.resolve(JSON.stringify({ voice: 0.9, grounding: 0.9, relevance: 0.9, novelty: 0.2, reasons: ["you already told them sccache helps"], fix: "you already recommended sccache to them; take a new angle" }));
    const v = await verifyDrafts([reply("honestly sccache is the move for rust builds")], { ...ctx, priorRepliesToPerson: ["sccache fixed my rust build times too"] }, judge);
    expect(v.scores.novelty).toBe(0.2);
    expect(v.pass).toBe(false);
    expect(v.fix).toContain("new angle");
  });

  it("PASSES a fresh draft even when there IS prior history", async () => {
    const v = await verifyDrafts([reply("i swapped the linker for mold and my link step halved")], { ...ctx, priorRepliesToPerson: ["sccache fixed my rust build times too"] }, () => Promise.resolve(cleanFour));
    expect(v.scores.novelty).toBe(0.9);
    expect(v.pass).toBe(true);
  });

  it("forces novelty=1.0 on FIRST contact (no prior replies) — never penalizes", async () => {
    // judge claims low novelty, but with no history it must be ignored.
    const judge = () => Promise.resolve(JSON.stringify({ voice: 0.9, grounding: 0.9, relevance: 0.9, novelty: 0.1, reasons: [], fix: null }));
    const v = await verifyDrafts([reply("mold is a great linker for rust")], { ...ctx, priorRepliesToPerson: [] }, judge);
    expect(v.scores.novelty).toBe(1);
    expect(v.pass).toBe(true);
  });

  it("defaults novelty to 1.0 when the judge omits it (back-compat)", async () => {
    const v = await verifyDrafts([reply("mold is a great linker")], ctx, goodJudge);
    expect(v.scores.novelty).toBe(1);
  });

  it("shows the PRIOR REPLIES block to the judge only when history exists", async () => {
    let seenPrompt = "";
    const spy = (_system: string, prompt: string) => {
      seenPrompt = prompt;
      return Promise.resolve(cleanFour);
    };
    await verifyDrafts([reply("x")], { ...ctx, priorRepliesToPerson: ["earlier reply about sccache"] }, spy);
    expect(seenPrompt).toContain("PRIOR REPLIES TO THIS PERSON");
    expect(seenPrompt).toContain("earlier reply about sccache");

    seenPrompt = "";
    await verifyDrafts([reply("x")], ctx, spy);
    expect(seenPrompt).not.toContain("PRIOR REPLIES TO THIS PERSON");
  });

  it("verifyTiered medians novelty across judges", async () => {
    const j = (n: number) => () => Promise.resolve(JSON.stringify({ voice: 0.9, grounding: 0.9, relevance: 0.9, novelty: n, reasons: [], fix: null }));
    const v = await verifyTiered([reply("x")], { ...ctx, priorRepliesToPerson: ["prior"] }, [j(0.2), j(0.9), j(0.8)]);
    expect(v.scores.novelty).toBe(0.8); // median of 0.2/0.8/0.9
  });
});

describe("replyDiversityScore (feed-wide repetition)", () => {
  it("scores a near-verbatim repeat LOW", () => {
    const { score } = replyDiversityScore(
      "sccache cut my rust builds in half, worth a look",
      ["sccache cut my rust builds in half, worth a try"],
    );
    expect(score).toBeLessThan(0.5);
  });

  it("flags a reused opener/template even on a different topic", () => {
    // Same "honestly the X is the real bottleneck, try Y" shape.
    const { score } = replyDiversityScore(
      "honestly i swapped in mold and my link step halved",
      ["honestly i swapped in sccache and my build cache stopped thrashing"],
    );
    expect(score).toBeLessThan(0.7);
  });

  it("scores two genuinely distinct replies HIGH", () => {
    const { score } = replyDiversityScore(
      "the pricing tiers feel off for early teams",
      ["congrats on the seed round, that is a real milestone", "the cohort retention angle is underrated here"],
    );
    expect(score).toBeGreaterThan(0.8);
  });

  it("does not flag two replies that merely share a tiny opener ('this is')", () => {
    const { score } = replyDiversityScore(
      "this is a sharp framing of the tradeoff between speed and safety",
      ["this is the kind of nuance most product teams completely miss"],
    );
    expect(score).toBeGreaterThan(0.7);
  });

  it("returns 1.0 with no recent history", () => {
    expect(replyDiversityScore("anything goes here", []).score).toBe(1);
    expect(replyDiversityScore("anything goes here").score).toBe(1);
  });
});

describe("feed-wide diversity dimension (verifyDrafts)", () => {
  const cleanJudge = goodJudge;

  it("FAILS a reply that echoes a recent reply across the feed", async () => {
    const v = await verifyDrafts(
      [reply("sccache cut my rust builds in half, worth a look")],
      { ...ctx, recentReplies: ["sccache cut my rust builds in half, worth a try"] },
      cleanJudge,
    );
    expect(v.scores.diversity).toBeLessThan(0.7);
    expect(v.pass).toBe(false);
    expect(v.fix).toContain("different shape");
  });

  it("PASSES a distinct reply even when there IS recent history", async () => {
    const v = await verifyDrafts(
      [reply("mold is the linker that actually moved the needle for us")],
      { ...ctx, recentReplies: ["sccache cut my rust builds in half, worth a try"] },
      cleanJudge,
    );
    expect(v.scores.diversity).toBeGreaterThanOrEqual(0.7);
    expect(v.pass).toBe(true);
  });

  it("forces diversity=1.0 when there is no recent history (back-compat)", async () => {
    const v = await verifyDrafts([reply("a clean grounded reply about rust builds")], ctx, cleanJudge);
    expect(v.scores.diversity).toBe(1);
  });

  it("exempts DM drafts from the diversity check", async () => {
    const dm: DraftToVerify = { kind: "dm", angle: null, body: "sccache cut my rust builds in half, worth a try" };
    const v = await verifyDrafts([dm], { ...ctx, recentReplies: ["sccache cut my rust builds in half, worth a try"] }, cleanJudge);
    expect(v.scores.diversity).toBe(1);
  });

  it("verifyTiered keeps the strictest (min) diversity across judges", async () => {
    const v = await verifyTiered(
      [reply("sccache cut my rust builds in half, worth a look")],
      { ...ctx, recentReplies: ["sccache cut my rust builds in half, worth a try"] },
      [goodJudge, goodJudge],
    );
    expect(v.scores.diversity).toBeLessThan(0.7);
    expect(v.pass).toBe(false);
  });
});

// judgeOk exposes whether the LLM judge GENUINELY returned. Consumers that must
// fail CLOSED (the X unattended auto-send gate) require judgeOk===true; a
// fail-open pass (judge threw / unparseable) is pass:true but judgeOk:false.
describe("judgeOk (fail-closed signal)", () => {
  it("marks judgeOk=false when the judge throws (still passes open)", async () => {
    const v = await verifyDrafts(
      [reply("a clean grounded reply")],
      ctx,
      () => Promise.reject(new Error("503")),
    );
    expect(v.pass).toBe(true);
    expect(v.judgeOk).toBe(false);
  });

  it("marks judgeOk=false on unparseable judge output", async () => {
    const v = await verifyDrafts(
      [reply("a clean grounded reply")],
      ctx,
      () => Promise.resolve("I think it's fine!"),
    );
    expect(v.pass).toBe(true);
    expect(v.judgeOk).toBe(false);
  });

  it("marks judgeOk=true on a good judge", async () => {
    const v = await verifyDrafts([reply("sccache cut my rust builds in half, worth a look")], ctx, goodJudge);
    expect(v.judgeOk).toBe(true);
  });

  it("verifyTiered: one judge throwing makes the SET judgeOk=false (every())", async () => {
    const throwing = () => Promise.reject(new Error("503"));
    const v = await verifyTiered(
      [reply("sccache cut my rust builds in half, worth a look")],
      ctx,
      [goodJudge, goodJudge, throwing],
    );
    // Two good judges still carry the majority pass, but the set is NOT judge-ok
    // because one judge did not genuinely return.
    expect(v.pass).toBe(true);
    expect(v.judgeOk).toBe(false);
  });
});

describe("Jev-first draft verification", () => {
  const jevAnswers = (probability: number) => async (request: { questions: Record<string, unknown> }) => ({
    answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: "boolean", probability }])),
  });

  it("uses clear Jev scores without calling the legacy judge", async () => {
    let legacyCalls = 0;
    const verdict = await verifyDrafts([reply("sccache cut my rust builds in half, worth a look")], ctx,
      async () => { legacyCalls++; return goodJudge(); }, { jevRun: jevAnswers(0.93) });
    expect(verdict.pass).toBe(true);
    expect(verdict.judgeOk).toBe(true);
    expect(verdict.judgeProvider).toBe("jev");
    expect(verdict.scores.voice).toBe(0.93);
    expect(legacyCalls).toBe(0);
  });

  it("routes the pinned faithful voice target through Jev-first verification", async () => {
    let jevState = "";
    let voiceQuestion = "";

    const verdict = await verifyDrafts(
      [reply("this is kind of ridiculous (I love it)")],
      {
        ...ctx,
        faithfulVoiceAnchors: ["@eliana_jordan: tiny warm reaction (playful aside)"],
      },
      async () => { throw new Error("legacy should not run"); },
      {
        jevRun: async (request) => {
          jevState = request.state;
          voiceQuestion = request.questions.voice!.instructions;
          return { answers: {
            voice: { type: "boolean", probability: 0.93 },
            grounding: { type: "boolean", probability: 0.93 },
            relevance: { type: "boolean", probability: 0.93 },
          } };
        },
      },
    );

    expect(jevState).toContain("faithfulVoiceAnchors");
    expect(jevState).toContain("@eliana_jordan: tiny warm reaction (playful aside)");
    expect(voiceQuestion).toMatch(/pinned faithful voice target.*authoritative/i);
    expect(voiceQuestion).toMatch(/short repl(?:y|ies).*not.*same length.*topic.*post structure/i);
    expect(verdict.judgeProvider).toBe("jev");
    expect(verdict.pass).toBe(true);
  });

  it("repairs a short faithful reply without copying the longer post shape", async () => {
    const verdict = await verifyDrafts(
      [reply("generic corporate acknowledgement")],
      { ...ctx, faithfulVoiceAnchors: ["@eliana_jordan: a much longer original post"] },
      async () => { throw new Error("legacy should not run"); },
      {
        jevRun: async () => ({ answers: {
          voice: { type: "boolean", probability: 0.2 },
          grounding: { type: "boolean", probability: 0.93 },
          relevance: { type: "boolean", probability: 0.93 },
        } }),
      },
    );

    expect(verdict.pass).toBe(false);
    expect(verdict.fix).toMatch(/short reply.*without copying.*length.*topic.*post structure/i);
    expect(verdict.fix).toMatch(/tiny reaction can be fully on-voice/i);
  });

  it("rejects clear Jev quality failures without a fallback", async () => {
    const verdict = await verifyDrafts([reply("sccache cut my rust builds in half, worth a look")], ctx,
      async () => { throw new Error("legacy should not run"); }, { jevRun: jevAnswers(0.15) });
    expect(verdict.pass).toBe(false);
    expect(verdict.judgeOk).toBe(true);
    expect(verdict.judgeProvider).toBe("jev");
    expect(verdict.fix).toContain("voice");
  });

  it("gives the writer a grounding repair when Jev clearly rejects an invented operator claim", async () => {
    const legacy = vi.fn(goodJudge);
    const verdict = await verifyDrafts([reply("I keep every agent draft behind an approval click")], {
      ...ctx,
      platform: "linkedin",
      postText: "A demo shows the workflow; a showcase proves what people built with it.",
      voiceAnchors: ["Pinned writer example (FORM and voice only): I built my own agent workflow."],
    }, legacy, { jevRun: async () => ({ answers: {
      voice: { type: "boolean", probability: 0.91 },
      grounding: { type: "boolean", probability: 0.23 },
      relevance: { type: "boolean", probability: 0.92 },
    } }) });

    expect(verdict.pass).toBe(false);
    expect(verdict.judgeProvider).toBe("jev");
    expect(verdict.scores.grounding).toBe(0.23);
    expect(verdict.fix).toMatch(/remove.*unsupported.*(experience|process|product)/i);
    expect(verdict.fix).toMatch(/original post/i);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("grades short LinkedIn voice by transferable tone rather than pinned post length or topic", async () => {
    let voiceQuestion = "";
    const verdict = await verifyDrafts([reply("the showcase bit makes this feel real")], {
      ...ctx,
      platform: "linkedin",
      voiceAnchors: ["Pinned writer example (FORM and voice only): A long personal founder story."],
    }, goodJudge, { jevRun: async (request) => {
      voiceQuestion = request.questions.voice!.instructions;
      return { answers: {
        voice: { type: "boolean", probability: 0.12 },
        grounding: { type: "boolean", probability: 0.92 },
        relevance: { type: "boolean", probability: 0.91 },
      } };
    } });
    expect(voiceQuestion).toMatch(/tone.*register.*cadence/i);
    expect(voiceQuestion).toMatch(/length.*topic/i);
    expect(verdict.pass).toBe(false);
    expect(verdict.fix).toMatch(/short.*comment/i);
    expect(verdict.fix).toMatch(/tone.*register.*cadence/i);
  });

  it("asks Jev to check every draft when a LinkedIn set also includes a DM", async () => {
    let voiceQuestion = "";
    await verifyDrafts([
      reply("the showcase bit makes this feel real"),
      { kind: "dm", angle: null, body: "I liked the distinction you made between demos and showcases" },
    ], { ...ctx, platform: "linkedin" }, goodJudge, { jevRun: async (request) => {
      voiceQuestion = request.questions.voice!.instructions;
      return { answers: {
        voice: { type: "boolean", probability: 0.91 },
        grounding: { type: "boolean", probability: 0.92 },
        relevance: { type: "boolean", probability: 0.93 },
      } };
    } });

    expect(voiceQuestion).toMatch(/every draft/i);
    expect(voiceQuestion).not.toMatch(/each short comment/i);
    expect(voiceQuestion).toMatch(/reply drafts.*final period/i);
    expect(voiceQuestion).toMatch(/DMs.*punctuation/i);
  });

  it("falls back to the legacy judge for uncertain Jev dimensions", async () => {
    const verdict = await verifyDrafts([reply("sccache cut my rust builds in half, worth a look")], ctx,
      goodJudge, { jevRun: jevAnswers(0.6) });
    expect(verdict.judgeProvider).toBe("legacy");
    expect(verdict.judgeOk).toBe(true);
    expect(verdict.scores.voice).toBe(0.9);
  });

  it("tells the uncertain LinkedIn fallback that a public reply may end without a full stop", async () => {
    let system = "";
    await verifyDrafts([reply("A profile visit may warm up the next conversation")],
      { ...ctx, platform: "linkedin" }, async (instructions) => {
        system = instructions;
        return goodJudge();
      }, { jevRun: jevAnswers(0.6) });
    expect(system).toContain("Public replies intentionally omit full stops");
    expect(system).toContain("Do not penalize a missing final period");
  });

  it("keeps a clear Jev failure when another dimension is uncertain", async () => {
    const legacy = vi.fn(goodJudge);
    const verdict = await verifyDrafts([reply("sccache cut my rust builds in half, worth a look")], ctx,
      legacy, { jevRun: async () => ({ answers: {
        voice: { type: "boolean", probability: 0.15 },
        grounding: { type: "boolean", probability: 0.74 },
        relevance: { type: "boolean", probability: 0.93 },
      } }) });
    expect(verdict.pass).toBe(false);
    expect(verdict.judgeOk).toBe(true);
    expect(verdict.judgeProvider).toBe("jev");
    expect(verdict.scores.voice).toBe(0.15);
    expect(verdict.fix).toContain("voice");
    expect(legacy).not.toHaveBeenCalled();
  });

  it("uses the legacy judge only to fill uncertain dimensions", async () => {
    const verdict = await verifyDrafts([reply("sccache cut my rust builds in half, worth a look")], ctx,
      async () => JSON.stringify({ voice: 0.2, grounding: 0.9, relevance: 0.1, reasons: [], fix: null }),
      { jevRun: async () => ({ answers: {
        voice: { type: "boolean", probability: 0.92 },
        grounding: { type: "boolean", probability: 0.62 },
        relevance: { type: "boolean", probability: 0.94 },
      } }) });
    expect(verdict.pass).toBe(true);
    expect(verdict.judgeOk).toBe(true);
    expect(verdict.judgeProvider).toBe("mixed");
    expect(verdict.scores).toMatchObject({ voice: 0.92, grounding: 0.9, relevance: 0.94 });
  });

  it("keeps fallback feedback on the dimensions the fallback actually decides", async () => {
    const verdict = await verifyDrafts([reply("sccache cut my rust builds in half, worth a look")], ctx,
      async () => JSON.stringify({ voice: 0.2, grounding: 0.2, relevance: 0.1,
        reasons: ["Voice is too generic"], fix: "Rewrite the voice" }),
      { jevRun: async () => ({ answers: {
        voice: { type: "boolean", probability: 0.92 },
        grounding: { type: "boolean", probability: 0.62 },
        relevance: { type: "boolean", probability: 0.94 },
      } }) });
    expect(verdict.pass).toBe(false);
    expect(verdict.judgeProvider).toBe("mixed");
    expect(verdict.reasons.join(" ")).toContain("grounding");
    expect(verdict.reasons.join(" ")).not.toContain("Voice is too generic");
    expect(verdict.fix).toContain("grounding");
    expect(verdict.fix).not.toContain("Rewrite the voice");
  });

  it("turns an uncertain LinkedIn voice failure into a specific non-summary repair", async () => {
    const verdict = await verifyDrafts([reply("Seven touchpoints may warm up the cold message")],
      { ...ctx, platform: "linkedin" },
      async () => JSON.stringify({ voice: 0.45, grounding: 0.9, relevance: 0.9,
        reasons: ["It only repeats the post"], fix: "Add a new angle" }),
      { jevRun: async () => ({ answers: {
        voice: { type: "boolean", probability: 0.61 },
        grounding: { type: "boolean", probability: 0.93 },
        relevance: { type: "boolean", probability: 0.91 },
      } }) });
    expect(verdict.pass).toBe(false);
    expect(verdict.judgeProvider).toBe("mixed");
    expect(verdict.fix).toMatch(/source-grounded.*question/i);
    expect(verdict.fix).toMatch(/not.*(?:recap|restate).*number/i);
    expect(verdict.fix).not.toContain("Add a new angle");
  });

  it("cannot auto-approve clear Jev passes when their uncertain fallback fails", async () => {
    const verdict = await verifyDrafts([reply("sccache cut my rust builds in half, worth a look")], ctx,
      async () => { throw new Error("legacy down"); },
      { jevRun: async () => ({ answers: {
        voice: { type: "boolean", probability: 0.91 },
        grounding: { type: "boolean", probability: 0.67 },
        relevance: { type: "boolean", probability: 0.95 },
      } }) });
    expect(verdict.judgeOk).toBe(false);
    expect(verdict.judgeProvider).toBe("none");
    expect(verdict.scores.voice).toBe(0.91);
  });

  it("does not mark a double-failed judge as genuine", async () => {
    const verdict = await verifyDrafts([reply("sccache cut my rust builds in half, worth a look")], ctx,
      async () => { throw new Error("legacy down"); }, { jevRun: async () => { throw new Error("jev down"); } });
    expect(verdict.judgeProvider).toBe("none");
    expect(verdict.judgeOk).toBe(false);
  });
});

// ---- anti-ai skill: reader-mode tells (LinkedIn/strictVoice only) ----------
// Sourced from the operator's `anti-ai` skill. Every case below asserts BOTH
// legs: the tell hard-zeroes when strictVoice is on, and the SAME body is
// untouched when it is off (so Vega/Orion behavior is provably unchanged).
const strict = (body: string) => scoreFormat(reply(body), undefined, false, true);
const loose = (body: string) => scoreFormat(reply(body), undefined, false, false);

describe("scoreFormat — anti-ai significance markers (constraint 14)", () => {
  const MARKERS = [
    // NB: "that's the PART that…" is intentionally NOT here — SLOP_PHRASES
    // already bans it platform-wide, so duplicating it only crowded the
    // approval card. "bit" is the variant this family genuinely adds.
    "sccache cut our builds to 40s. that's the bit that got me",
    "we shipped it in a week, that's the uncomfortable part",
    "what got me was how long the cold start took",
    "the retries never fire, that's what kills me",
    "here's the thing, incremental builds were never the bottleneck",
    "the thing is, cargo caches the wrong layer",
    "we rewrote the resolver and that's the point",
    "it retries on a 500 which is exactly the problem",
    "four hours of CI per merge. let that sink in",
  ];
  for (const body of MARKERS) {
    it(`hard-zeroes a significance marker: "${body.slice(0, 34)}…"`, () => {
      const f = strict(body);
      expect(f.score).toBe(0);
      expect(f.reasons.join(" ")).toMatch(/significance-marking meta commentary/);
      // The fix must be DELETION, not rewording — that is what flipped the
      // verdict in the skill's single-variable field test.
      expect(f.reasons.join(" ")).toMatch(/DELETE the sentence outright/);
    });
    // NB: assert the NEW rule stays silent rather than score===1 — some of these
    // bodies also trip a pre-existing platform-agnostic SLOP_PHRASES entry (e.g.
    // "that's the part that…" already matched the "the part where/about/of/that"
    // ban), so a score assertion here would test the old rule, not this one.
    it(`does not fire the new rule when strictVoice is off: "${body.slice(0, 34)}…"`, () => {
      expect(loose(body).reasons.join(" ")).not.toMatch(/significance-marking meta commentary/);
    });
  }
});

describe("scoreFormat — anti-ai reader-mode constructions", () => {

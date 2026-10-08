import { describe, it, expect } from "vitest";
import {
  commitmentReason,
  detectCommitments,
  makesCommitment,
  NO_COMMITMENTS_RULE,
} from "./commitmentGuard.js";

describe("catches commitments the operator never made", () => {
  const cases: Array<[string, string]> = [
    ["future-action", "love this — I'll send you the deck tomorrow"],
    ["future-action", "happy to review it and get back to you"],
    ["future-action", "I can intro you to a couple of people"],
    ["future-action", "we'll cover the hosting for the first year"],
    ["future-action", "I’ll send you the deck tomorrow"],
    ["future-action", "We can send you the deck"],
    ["future-action", "We are going to introduce you to the team"],
    ["future-action", "We’re going to review your proposal"],
    ["scheduling", "Let’s hop on a call"],
    ["scheduling", "I’m free Thursday"],
    ["acceptance", "We’re in"],
    ["resource", "We’ll get you access"],
    ["scheduling", "let's hop on a call this week"],
    ["scheduling", "book a time here, my calendly is open"],
    ["scheduling", "what time works for you?"],
    ["scheduling", "I'm free Thursday if you are"],
    ["acceptance", "count me in"],
    ["acceptance", "yes, let's do it"],
    ["acceptance", "consider it done"],
    ["resource", "I'll get you access to the beta"],
    ["resource", "free access for you, on us"],
    ["speaking-for", "we have a yes from the operator!"],
    ["speaking-for", "he approved to move ahead"],
    ["speaking-for", "I got the green light on that"],
    ["speaking-for", "I'm speaking for the team here"],
  ];

  for (const [kind, text] of cases) {
    it(`${kind}: ${text}`, () => {
      const hits = detectCommitments(text);
      expect(hits.length, `expected a hit for: ${text}`).toBeGreaterThan(0);
      expect(hits.map((h) => h.kind)).toContain(kind);
      expect(makesCommitment(text)).toBe(true);
    });
  }

  it("catches a deadline only when something is promised into it", () => {
    expect(makesCommitment("I'll have it to you by Friday")).toBe(true);
    // Pure narration about someone else's timeline is not a commitment.
    expect(detectCommitments("they shipped the whole thing before Friday").map((h) => h.kind))
      .not.toContain("deadline");
  });
});

// The voice has to survive the guard. If ordinary warm, opinionated replies trip
// it, the drafter starves and every conversation dies — which is the exact
// failure the notifications actor was built to fix.
describe("leaves normal replies alone", () => {
  const clean = [
    "this is the part everyone underestimates, nice work",
    "congrats — a week to teach yourself econometrics is a ridiculous run",
    "I'll be honest, I think the opposite is true here",
    "I'll never understand why teams ship this way",
    "agreed, the hiring line is the interesting bit",
    "the classifier that blocks the fake vendor change also blocks the real one",
    "we shipped something similar last year and it broke in the same place",
    "thanks! that means a lot",
    "no idea honestly, but I'd love to see the data",
    "you're right that indecision is the real killer",
    "they got the green light after two years of this", // narration about a third party
    "I’ll be honest, we can learn a lot from this",
    "We are going to need a different approach someday",
    "They’ll send their proposal tomorrow",
  ];
  for (const text of clean) {
    it(`clean: ${text}`, () => {
      expect(detectCommitments(text), `false positive on: ${text}`).toEqual([]);
    });
  }
});

describe("named decision claims", () => {
  it.each(["Ada approved to move ahead", "José García says yes", "Wei Lin confirmed it's ok", "Élodie agreed to join"])("rejects %s with the original evidence", (text) => {
    const hits = detectCommitments(text);
    expect(hits).toEqual([{ kind: "speaking-for", match: text.replace(/ (?:move ahead|join)$/, "") }]);
  });

  it.each(["Ada shipped her project last week", "the documentation says yes for supported clients", "José wrote about approval workflows", "Wei Lin asked what comes next"])("keeps ordinary narration eligible: %s", (text) => {
    expect(detectCommitments(text)).toEqual([]);
  });
});

describe("commitmentReason", () => {
  it("renders a greppable, stable reason", () => {
    const r = commitmentReason(detectCommitments("let's hop on a call this week"));
    expect(r).toMatch(/^commitment:scheduling\(/);
  });

  it("is empty for a clean draft", () => {
    expect(commitmentReason([])).toBe("");
  });

  it("truncates a long match so the reason column stays sane", () => {
    const long = `I'll send ${"x".repeat(200)}`;
    const r = commitmentReason(detectCommitments(long));
    expect(r.length).toBeLessThan(100);
  });
});

describe("edge cases", () => {
  it("handles empty and whitespace input", () => {
    expect(detectCommitments("")).toEqual([]);
    expect(detectCommitments("   ")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(makesCommitment("COUNT ME IN")).toBe(true);
    expect(makesCommitment("Let's Hop On A Call")).toBe(true);
  });

  it("keeps the original apostrophe in the exact matched evidence", () => {
    const hit = detectCommitments("Thanks. I’ll send you the deck").find((h) => h.kind === "future-action");
    expect(hit?.match).toBe("I’ll send");
    expect(commitmentReason([hit!])).toBe('commitment:future-action("I’ll send")');
  });

  it("ships a prompt rule that names every banned category", () => {
    for (const phrase of ["promise", "call", "count me in", "deadline", "behalf"]) {
      expect(NO_COMMITMENTS_RULE.toLowerCase()).toContain(phrase);
    }
  });
});

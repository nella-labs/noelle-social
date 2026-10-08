import { describe, it, expect } from "vitest";
import { stripSentencePeriods } from "./voiceSanitize.js";
import { polishReplyBody, NO_PERIODS_RULE } from "./replyPolish.js";

describe("stripSentencePeriods", () => {
  it("removes the full stop between two sentences, leaving one space", () => {
    expect(stripSentencePeriods("gm posts are the part i'd cut. i showed up daily")).toBe(
      "gm posts are the part i'd cut i showed up daily",
    );
  });

  it("removes a trailing full stop", () => {
    expect(stripSentencePeriods("that tracks.")).toBe("that tracks");
  });

  it("keeps every dot that lives inside a token", () => {
    for (const body of [
      "$0.66 per visitor with an 82% bounce still counts",
      "qwen 3.8 locally as the support model is the piece i want",
      "9.0 against Horizon Trio's 9.5, that's close",
      "shipped on getnella.dev this week",
      "see https://x.com/foo for the thread",
      "3.5 stars for the thing that builds everything",
    ]) {
      expect(stripSentencePeriods(body), body).toBe(body);
    }
  });

  it("collapses a long-hand ellipsis instead of halving it", () => {
    expect(stripSentencePeriods("i mean... maybe")).toBe("i mean maybe");
    expect(stripSentencePeriods("i mean...")).toBe("i mean");
  });

  it("leaves a real ellipsis character alone", () => {
    expect(stripSentencePeriods("the part where you said…")).toBe("the part where you said…");
  });

  it("does not touch question or exclamation marks", () => {
    const body = "does the 57% zero bucket separate dead projects? wild!";
    expect(stripSentencePeriods(body)).toBe(body);
  });

  it("catches a dot hiding behind a closing bracket or quote", () => {
    expect(stripSentencePeriods("(my queue exists for this.) yep")).toBe("(my queue exists for this) yep");
    expect(stripSentencePeriods('he called it "a filing cabinet." brutal')).toBe(
      'he called it "a filing cabinet" brutal',
    );
  });

  it("is idempotent", () => {
    const once = stripSentencePeriods("one thing. then another. done.");
    expect(stripSentencePeriods(once)).toBe(once);
    expect(once).toBe("one thing then another done");
  });

  it("never leaves a double space or trailing whitespace", () => {
    expect(stripSentencePeriods("a. b. c.")).toBe("a b c");
    expect(/ {2,}|\s$/.test(stripSentencePeriods("a.  b."))).toBe(false);
  });
});

describe("polishReplyBody", () => {
  it("strips periods even when the typo rate is 0", () => {
    const out = polishReplyBody("that tracks. every time.", { platform: "x", typoRate: 0 });
    expect(out.body).toBe("that tracks every time");
    expect(out.typo).toBeNull();
    expect(out.periodsStripped).toBe(true);
  });

  it("reports a clean no-op body unchanged", () => {
    const body = "does the 57% zero bucket separate dead projects?";
    const out = polishReplyBody(body, { platform: "x", typoRate: 0 });
    expect(out.body).toBe(body);
    expect(out.periodsStripped).toBe(false);
  });

  // Order matters: the typo pass budgets against the platform cap, so it has to
  // see the text AFTER the periods are gone, not before.
  it("strips periods before applying the typo, never after", () => {
    const body = "the deploy went fine. the alerting never fired at all. nobody knew for hours.";
    for (let i = 0; i < 200; i++) {
      const out = polishReplyBody(body, { platform: "x", typoRate: 1 });
      expect(out.body).not.toContain(". ");
      expect(out.body.endsWith(".")).toBe(false);
    }
  });

  // The pass never GROWS a reply past the cap. It does not shrink one that was
  // already over: a 300-char X draft is the drafter's bug, not this pass's job.
  it("never grows a near-cap X reply past 280", () => {
    const body = `${"the alerting story is the same shape too so ".repeat(6)}yep.`.slice(0, 279);
    expect(body.length).toBeLessThanOrEqual(280);
    for (let i = 0; i < 200; i++) {
      expect(polishReplyBody(body, { platform: "x", typoRate: 1 }).body.length).toBeLessThanOrEqual(280);
    }
  });

  it("the prompt rule names the exception cases, so the model does not over-strip", () => {
    expect(NO_PERIODS_RULE).toContain("NO FULL STOPS");
    // Must stay brand-agnostic: it ships inside the generic base prompts.
    expect(NO_PERIODS_RULE).not.toMatch(/nella|demooperator/i);
    expect(NO_PERIODS_RULE).toContain("domain or URL");
    expect(NO_PERIODS_RULE.toLowerCase()).toContain("question mark");
  });
});

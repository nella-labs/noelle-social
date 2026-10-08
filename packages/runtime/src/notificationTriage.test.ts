import { describe, it, expect } from "vitest";
import {
  MAX_CONVERSATION_TURNS,
  renderPin,
  triageNotification,
} from "./notificationTriage.js";

const v = (text: string, priorTurns = 0) => triageNotification({ text, priorTurns }).verdict;

describe("pins the ones a human has to take", () => {
  const opportunities = [
    "we're putting together a seed round, would love to talk",
    "any interest in a full-time role with us?",
    "can I intro you to our CTO?",
    "would you speak at our conference in March?",
    "interested in a partnership?",
    "what's your pricing for a team of 20?",
    "can we hop on a call this week?",
    "just sent you a DM",
    "we run an accelerator, you should apply",
    "would you come on the podcast?",
  ];
  for (const text of opportunities) {
    it(`pin: ${text}`, () => {
      const d = triageNotification({ text });
      expect(d.verdict, text).toBe("pin");
      expect(d.reason).toMatch(/^opportunity:/);
    });
  }

  it("pins even when the message is short and pleasantry-shaped", () => {
    // "thanks! can we jump on a call?" is BOTH a closing shape and the single
    // most important kind to escalate. Opportunity has to win.
    expect(v("thanks! can we jump on a call?")).toBe("pin");
  });

  it("pins past the turn cap too — an opportunity is never dropped for being late", () => {
    expect(v("we'd like to invest", 99)).toBe("pin");
  });

  it.each([
    ["Would you like to collaborate?", "partnership"],
    ["We are looking for collaborators", "partnership"],
    ["Interested in a collaboration?", "partnership"],
    ["We are recruiting developers for a project", "work-offer"],
    ["Our recruiter would like to discuss your experience", "work-offer"],
    ["We have a recruitment opportunity for you", "work-offer"],
  ])("pins natural opportunity forms past the turn cap: %s", (text, reason) => {
    expect(triageNotification({ text, priorTurns: 99 })).toEqual({
      verdict: "pin", reason: `opportunity:${reason}`,
    });
  });
});

describe("ignores the ones with nothing to answer", () => {
  const nothing = [
    "thanks!",
    "thank you so much!!",
    "congrats 🙏",
    "💯",
    "🔥🔥🔥",
    "agreed",
    "exactly this",
    "well said!",
    "100%",
  ];
  for (const text of nothing) {
    it(`ignore: ${text}`, () => {
      expect(v(text), text).toBe("ignore");
    });
  }

  it("ignores once the conversation has had its turns", () => {
    expect(v("and another thing about the architecture entirely", MAX_CONVERSATION_TURNS)).toBe("ignore");
    expect(triageNotification({ text: "more thoughts here on the design", priorTurns: MAX_CONVERSATION_TURNS }).reason).toBe("turn-cap");
  });

  it("ignores an empty or punctuation-only message", () => {
    expect(v("")).toBe("ignore");
    expect(v("   ")).toBe("ignore");
    expect(v("!!!")).toBe("ignore");
  });
});

describe("replies to the ones worth answering", () => {
  const worth = [
    "disagree — the classifier that blocks the fake vendor change also blocks the real one",
    "how do you handle the case where the agent never sees the dependency drift?",
    "we tried this exact thing last year and it fell over at about 40k rows",
    "what made you pick those two verticals?",
  ];
  for (const text of worth) {
    it(`reply: ${text}`, () => {
      expect(v(text), text).toBe("reply");
    });
  }

  it("answers a SHORT message when it is a question", () => {
    expect(v("why though?")).toBe("reply");
  });

  it("does not answer a short non-question", () => {
    expect(v("makes sense")).toBe("ignore");
  });
});

describe("renderPin", () => {
  it("names the platform, the reason and the person, and drafts nothing", () => {
    const p = renderPin({
      platform: "x",
      author: "alice",
      text: "we'd love to invest",
      reason: "opportunity:investment",
    });
    expect(p.title).toBe("X — investment from @alice");
    expect(p.message).toContain("we'd love to invest");
    // The whole point of a pin is that no agent answers it.
    expect(p.message).toContain("this one is yours");
  });

  it("handles a missing author and an @-prefixed one", () => {
    expect(renderPin({ platform: "linkedin", author: null, text: "hi", reason: "opportunity:intro" }).title)
      .toBe("LinkedIn — intro from someone");
    expect(renderPin({ platform: "x", author: "@bob", text: "hi", reason: "opportunity:intro" }).title)
      .toBe("X — intro from @bob");
  });

  it("truncates a long message so the push is readable", () => {
    const p = renderPin({ platform: "x", author: "a", text: "x".repeat(900), reason: "opportunity:sales" });
    expect(p.message.length).toBeLessThan(400);
  });
});

// The worst outcome this feature can produce is a REAL opportunity that gets
// neither a reply nor a push — silently filed away. The drafters guard that by
// marking an undelivered pin 'errored' rather than 'skipped'; these lock the
// decision half of that contract (the verdict must actually be "pin" for the
// cases that matter, so the delivery path is exercised at all).
describe("pin verdicts are the ones that must never be lost", () => {
  const mustPin = [
    "we'd like to lead your seed round",
    "we have a role open, would you be interested?",
    "happy to introduce you to our head of eng",
    "can I get pricing for 50 seats?",
  ];
  for (const text of mustPin) {
    it(`must pin (never reply, never silently ignore): ${text}`, () => {
      const d = triageNotification({ text, priorTurns: 5 }); // even past the cap
      expect(d.verdict).toBe("pin");
      expect(d.reason.startsWith("opportunity:")).toBe(true);
    });
  }

  it("never returns 'reply' for anything that reads like an opportunity", () => {
    for (const text of mustPin) {
      expect(triageNotification({ text }).verdict).not.toBe("reply");
    }
  });
});

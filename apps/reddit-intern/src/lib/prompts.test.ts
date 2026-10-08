import { describe, expect, it } from "vitest";
import {
  SYSTEM_REDDIT_BASE,
  SYSTEM_REDDIT_LIGHT,
  renderBrandBlock,
  buildDrafterSystem,
  buildLightDrafterSystem,
} from "./prompts.js";

// The three reply-drafting system prompts that voice-variety relaxes.
const REPLY_PROMPTS = [SYSTEM_REDDIT_BASE, SYSTEM_REDDIT_LIGHT];

describe("Reddit system prompts keep the NEVER-DO hard core", () => {
  it("em dashes are still banned in every reply prompt", () => {
    for (const p of REPLY_PROMPTS) expect(p).toContain("Em dashes");
  });

  it("corporate / LinkedIn-speak is still banned in every reply prompt", () => {
    for (const p of REPLY_PROMPTS) {
      const lower = p.toLowerCase();
      expect(lower).toContain("unlock");
      expect(lower).toContain("leverage");
      expect(lower).toContain("streamline");
    }
  });

  it("echoing the post (the AI tell) is still banned in every reply prompt", () => {
    for (const p of REPLY_PROMPTS) {
      expect(p.toLowerCase()).toContain("echoing the post");
    }
  });

  it("the emoji allowlist is preserved in every reply prompt", () => {
    for (const p of REPLY_PROMPTS) expect(p).toContain("💀 😭 😛");
  });

  it("the reframe / negative-parallelism HARD BAN survives in the substantial prompts", () => {
    for (const p of [SYSTEM_REDDIT_BASE]) {
      const lower = p.toLowerCase();
      expect(lower).toContain("reframe");
      expect(lower).toContain("hard ban");
    }
  });

  it("the light prompt still forbids pitching", () => {
    expect(SYSTEM_REDDIT_LIGHT.toLowerCase()).toContain("do not pitch");
  });
});

describe("Reddit reply prompts ban fabricated biography", () => {
  it("every reply prompt forbids inventing personal history", () => {
    for (const p of REPLY_PROMPTS) {
      const lower = p.toLowerCase();
      expect(lower).toContain("invent");
      expect(lower).toMatch(/personal history|anecdote|biographical/);
    }
  });
});

describe("Reddit reply length matches the thread's energy (no LinkedIn char cap)", () => {
  it("the substantial prompts use the Reddit conversational length rule, not a char cap", () => {
    for (const p of [SYSTEM_REDDIT_BASE]) {
      // The LinkedIn 90-150 char floor must not have leaked in.
      expect(p).not.toContain("90 to 150");
      const lower = p.toLowerCase();
      expect(lower).toContain("1 to 4 sentences");
      expect(lower).toContain("energy");
    }
  });
});

describe("Reddit reply prompts carry the casual-voice license (ports the Lyra/X parity)", () => {
  it("the substantial prompts explicitly allow run-ons, parentheticals, and lowercase", () => {
    for (const p of [SYSTEM_REDDIT_BASE]) {
      const lower = p.toLowerCase();
      expect(lower).toContain("run-on");
      expect(lower).toContain("parenthetical");
      expect(lower).toContain("lowercase mid-sentence");
      // ...and anchor AGAINST a polished register, not on one.
      expect(lower).toContain('"professional network" register');
    }
  });

  it('"honestly" stays available as texture/connector — no hard ban anywhere', () => {
    // The Lyra lesson (#427): a natural "honestly" is how the operator talks;
    // only the reflexive hedge-opener/tic is a problem. SYSTEM_REDDIT_BASE names it
    // as an allowed connector, and no prompt hard-bans the word.
    expect(SYSTEM_REDDIT_BASE).toContain("honestly");
    for (const p of REPLY_PROMPTS) {
      expect(p).not.toMatch(/honestly[^\n]*\(HARD BAN/i);
    }
  });
});

describe("buildDrafterSystem injects Pattern Breaker rules", () => {
  it("includes sent reply exemplars when they are the only optional context", () => {
    const exemplars = [{ post: "The approval handoff takes a day", reply: "That handoff is where the queue piles up" }];
    const system = buildDrafterSystem(null, null, null, exemplars);
    expect(system).toContain(exemplars[0]!.post);
    expect(system).toContain(exemplars[0]!.reply);
    expect(system.startsWith(SYSTEM_REDDIT_BASE)).toBe(true);
    expect(buildDrafterSystem(null, null, null, [])).toBe(SYSTEM_REDDIT_BASE);
  });

  const rules = [
    { instruction: "Do not end a substantive comment with a bare 'congrats'; end on the actual point." },
    { instruction: "Vary your opener; you keep leading with a one-line hook." },
  ];

  it("renders the BREAK THESE REPEATED PATTERNS block with each instruction", () => {
    const sys = buildDrafterSystem("obj", null, rules);
    expect(sys).toContain("BREAK THESE REPEATED PATTERNS");
    expect(sys).toContain("bare 'congrats'");
    expect(sys).toContain("Vary your opener");
  });

  it("omits the block entirely when there are no rules (byte-identical prompt)", () => {
    expect(buildDrafterSystem(null, null, [])).toBe(SYSTEM_REDDIT_BASE);
    expect(buildDrafterSystem(null, null, undefined)).toBe(SYSTEM_REDDIT_BASE);
  });

  it("the light system prompt threads the rules too", () => {
    const sys = buildLightDrafterSystem("obj", null, rules);
    expect(sys).toContain("BREAK THESE REPEATED PATTERNS");
    expect(buildLightDrafterSystem("obj", null, [])).not.toContain("BREAK THESE REPEATED PATTERNS");
  });

  it("appends the positive 'instead' mirror to a rule that has a suggestion", () => {
    const sys = buildDrafterSystem("obj", null, [
      { instruction: "Do not open with a raw-detail fragment.", suggestion: "Open with your actual take or a question." },
    ]);
    expect(sys).toContain("→ instead: Open with your actual take or a question.");
    // A rule without a suggestion stays a plain bullet.
    expect(buildDrafterSystem("obj", null, rules)).not.toContain("→ instead:");
  });
});

describe("renderBrandBlock forces first-person POV", () => {
  it("tells the model it IS the operator and writes first person, not third", () => {
    const block = renderBrandBlock({
      persona: { name: "Ari", bio: "founder" },
    } as never);
    const lower = block.toLowerCase();
    expect(lower).toContain("first person");
    expect(block).toContain("You ARE Ari");
    expect(block).not.toContain("drafting as:");
  });
});

describe("Reddit system prompts allow an ASSIGNED REGISTER override", () => {
  it("every reply prompt references the assigned-register block and allows caps + slang", () => {
    for (const p of REPLY_PROMPTS) {
      expect(p).toContain("ASSIGNED REGISTER FOR THIS REPLY");
      const lower = p.toLowerCase();
      expect(lower).toContain("all-caps");
      expect(lower).toContain("slang");
    }
  });
});

it("honors a policy-only never config instead of the legacy product prompt", () => {
  expect(buildDrafterSystem(null, { pitch_policy: "never", qa: [] })).toContain("PITCH POLICY: never");
});


it("requires configured identity and product facts for unbranded drafting", () => {
  const prompt = buildDrafterSystem();
  expect(prompt).toContain("do not pitch without a verified product brief");
  expect(prompt).not.toContain("OPERATOR BRAND (set by the operator");
});

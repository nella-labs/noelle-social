import { describe, expect, it } from "vitest";
import {
  SYSTEM_LINKEDIN_BASE,
  SYSTEM_LINKEDIN_LIGHT,
  SYSTEM_LINKEDIN_INTRO,
  buildLadderDmSystem,
  renderBrandBlock,
  renderStyleBlock,
  buildDrafterSystem,
  buildLightDrafterSystem,
  drafterSystemCachePrefixLen,
} from "./prompts.js";
import type { BrandConfig } from "@noelle/contracts";

const sampleStyle = {
  exemplars: [
    { body: "omg congrats this is amazing!!!", accountHandle: "k", likeCount: 50, commentCount: 0 },
  ],
  styleNotes: "Voice: warm and hyped",
};

// The three reply-drafting system prompts that voice-variety relaxes. The DM /
// intro-DM prompts are deliberately excluded (the register never touches them).
const REPLY_PROMPTS = [SYSTEM_LINKEDIN_BASE, SYSTEM_LINKEDIN_LIGHT];

describe("LinkedIn system prompts keep the NEVER-DO hard core", () => {
  it("em dashes are still banned in every reply prompt", () => {
    for (const p of REPLY_PROMPTS) expect(p).toContain("Em dashes");
  });

  it("corporate verbs are still banned in every reply prompt", () => {
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

  it("allows a grounded spoken acknowledgement while keeping generic praise banned", () => {
    for (const prompt of REPLY_PROMPTS) {
      const lower = prompt.toLowerCase();
      expect(lower).toContain("short spoken acknowledgement");
      expect(lower).toMatch(/post-specific (reason|referent)/);
      expect(lower).toContain("portable generic praise");
      expect(lower).toContain("engagement-bait");
      expect(lower).toContain("stay banned");
    }
  });

  it("the emoji allowlist is preserved in every reply prompt", () => {
    for (const p of REPLY_PROMPTS) expect(p).toContain("💀 😭 😛");
  });

  it("the reframe / negative-parallelism HARD BAN survives in the substantial prompts", () => {
    // (The light prompt is a plain congrats — no reframe rule, by design.)
    for (const p of [SYSTEM_LINKEDIN_BASE]) {
      const lower = p.toLowerCase();
      expect(lower).toContain("reframe");
      expect(lower).toContain("hard ban");
    }
  });

  it("the light prompt still forbids pitching", () => {
    expect(SYSTEM_LINKEDIN_LIGHT.toLowerCase()).toContain("do not pitch");
  });
});

describe("LinkedIn reply prompts ban fabricated biography", () => {
  it("every reply prompt forbids inventing personal history", () => {
    for (const p of REPLY_PROMPTS) {
      const lower = p.toLowerCase();
      expect(lower).toContain("invent");
      // names the failure mode explicitly so the model can't rationalise it
      expect(lower).toMatch(/personal history|anecdote|biographical/);
    }
  });
});

describe("browser-observed replies keep pinned style separate from post facts", () => {
  it("uses the operator's sent replies as the browser voice target while keeping pinned form and an assigned shape", () => {
    const style = { ...sampleStyle, formVariant: { id: "TWO_LINE" as const, directive: "Use two short lines with one idea each" } };
    const sent = [{ post: "A founder found an approval bottleneck", reply: "The handoff is where the queue piles up" }];
    const browser = buildDrafterSystem(null, null, null, style, "neutral", null, true, sent, true);
    const legacy = buildDrafterSystem(null, null, null, style, "neutral", null, true, sent, false);

    expect(browser).toContain("The handoff is where the queue piles up");
    expect(browser).toMatch(/operator's actually sent replies.*voice/i);
    expect(browser).toMatch(/pinned writer.*form/i);
    expect(browser).toContain("Use two short lines with one idea each");
    expect(browser).toMatch(/concrete constraint or unresolved implication/i);
    expect(browser).not.toContain("WRITE THIS REPLY IN THE VOICE OF THE WRITER BELOW");
    expect(legacy).toContain("WRITE THIS REPLY IN THE VOICE OF THE WRITER BELOW");
  });

  it("uses the operator's sent replies for light browser voice without changing legacy light prompts", () => {
    const sent = [{ post: "We launched today", reply: "Made it out of the spreadsheet!!" }];
    const browser = buildLightDrafterSystem(null, null, null, sampleStyle, "celebration", null, true, true, sent);
    const legacy = buildLightDrafterSystem(null, null, null, sampleStyle, "celebration", null, true);
    expect(browser).toContain("Made it out of the spreadsheet!!");
    expect(browser).toMatch(/operator's actually sent replies.*voice/i);
    expect(browser).not.toContain("WRITE THIS REPLY IN THE VOICE OF THE WRITER BELOW");
    expect(legacy).toContain("WRITE THIS REPLY IN THE VOICE OF THE WRITER BELOW");
  });

  it("keeps the pinned voice when the operator has no sent reply examples", () => {
    const browser = buildDrafterSystem(null, null, null, sampleStyle, "neutral", null, true, [], true);
    const light = buildLightDrafterSystem(null, null, null, sampleStyle, "neutral", null, true, true, []);
    for (const prompt of [browser, light]) {
      expect(prompt).toContain("WRITE THIS REPLY IN THE VOICE OF THE WRITER BELOW");
    }
  });

  it("requires a source-post detail and forbids borrowing the pinned writer's claims", () => {
    const substantial = buildDrafterSystem(null, null, null, sampleStyle, "neutral", null, true, [], true);
    const light = buildLightDrafterSystem(null, null, null, sampleStyle, "celebration", null, true, true);

    for (const system of [substantial, light]) {
      expect(system).toMatch(/concrete detail.*original post/i);
      expect(system).toMatch(/pinned.*(writer|style).*examples.*(tone|form)/i);
      expect(system).toMatch(/never.*(personal|process|product).*claims/i);
    }
  });

  it("keeps hypothetical claims conditional and distinguishes an anecdote from evidence", () => {
    for (const system of [
      buildDrafterSystem(null, null, null, sampleStyle, "neutral", null, true, [], true),
      buildLightDrafterSystem(null, null, null, sampleStyle, "neutral", null, true, true),
    ]) {
      expect(system).toMatch(/if.*may.*conditional/i);
      expect(system).toMatch(/anecdote.*caus/i);
      expect(system).toMatch(/capital.*start.*no full stops/i);
    }
  });

  it("asks browser replies to add a source-based contribution instead of recapping the numeric hook", () => {
    for (const system of [
      buildDrafterSystem(null, null, null, sampleStyle, "neutral", null, true, [], true),
      buildLightDrafterSystem(null, null, null, sampleStyle, "neutral", null, true, true),
    ]) {
      expect(system).toMatch(/concrete detail.*original post/i);
      expect(system).toMatch(/unanswered question/i);
      expect(system).toMatch(/do not (?:summarize|recap).*numeric/i);
      expect(system).toMatch(/avoid asking for.*(?:metrics|methods).*not in the post/i);
    }
  });
});

describe("LinkedIn reply length matches the post's energy (no padding floor)", () => {
  it("the substantial prompts drop the 90-char floor and forbid manufactured insight", () => {
    for (const p of [SYSTEM_LINKEDIN_BASE]) {
      // the old "90 to 150 characters" floor that forced padding must be gone
      expect(p).not.toContain("90 to 150");
      const lower = p.toLowerCase();
      expect(lower).toContain("no minimum");
      expect(lower).toContain("energy");
      expect(lower).toMatch(/manufacture (a lesson|an "insight")|do not manufacture/);
    }
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
    // must NOT prime third-person narration the way "drafting as: Ari" did
    expect(block).not.toContain("drafting as:");
  });
});

describe("LinkedIn system prompts allow an ASSIGNED REGISTER override", () => {
  it("every reply prompt references the assigned-register block and allows caps + slang", () => {
    for (const p of REPLY_PROMPTS) {
      expect(p).toContain("ASSIGNED REGISTER FOR THIS REPLY");
      const lower = p.toLowerCase();
      expect(lower).toContain("all-caps");
      expect(lower).toContain("slang");
    }
  });

  it("the substantial prompts say the register never applies to the DM", () => {
    for (const p of [SYSTEM_LINKEDIN_BASE]) {
      expect(p.toLowerCase()).toContain("never applies to the dm");
    }
  });
});

describe("LinkedIn reply prompts allow 'honestly' as texture but ban the reflexive tic", () => {
  it("every reply prompt permits a natural honestly/tbh yet forbids the hedge-opener/tic", () => {
    for (const p of REPLY_PROMPTS) {

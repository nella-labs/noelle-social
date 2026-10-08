import { describe, expect, it } from "vitest";
import { parseBrandConfig } from "@noelle/contracts";
import { SYSTEM_X_BASE, buildDrafterSystem, renderBrandBlock, renderPersonProfile, renderOperatorFacts } from "./prompts.js";

describe("SYSTEM_X_BASE", () => {
  it("values useful contextual replies without a disagreement quota or reach promise", () => {
    for (const prompt of [SYSTEM_X_BASE]) {
      expect(prompt).toContain("Judge each reply on its own value");
      expect(prompt).toContain("A specific supportive milestone reaction");
      expect(prompt).toContain("Never manufacture disagreement");
      expect(prompt).not.toContain("Roughly one reply in three should disagree");
    }
  });

  it("is a non-empty string", () => {
    expect(SYSTEM_X_BASE.length).toBeGreaterThan(200);
  });

  it("has no hardcoded operator or product identity", () => {
    expect(SYSTEM_X_BASE).not.toContain("OPERATOR BRAND (set by the operator");
    expect(renderOperatorFacts(parseBrandConfig({}))).toEqual([]);
  });

  it("requires supplied context for operator identity and product claims", () => {
    expect(SYSTEM_X_BASE).toContain("do not invent identity, biography, product facts or an offer");
    expect(SYSTEM_X_BASE).toContain("do not pitch without a verified product brief");
  });

  it("does NOT instruct the model to decide skip/no-fit (gate lives upstream now)", () => {
    const lower = SYSTEM_X_BASE.toLowerCase();
    // The old prompt's gating phrases. If any reappear, the upstream
    // retrieval-score gate is being undermined by the prompt itself.
    expect(lower).not.toContain("skip-if-no-fit");
    expect(lower).not.toContain("skip if no product connection");
    expect(lower).not.toContain("mark the lead skipped");
    expect(lower).not.toMatch(/skip:\s*<one short reason>/);
  });

  it("instructs strict JSON output with one selected angle", () => {
    expect(SYSTEM_X_BASE).toContain('"drafts"');
    expect(SYSTEM_X_BASE).toContain('"empathetic|technical|contrarian"');
    expect(SYSTEM_X_BASE).toContain("Output exactly ONE reply draft");
  });

  it("forbids echoing the post back (the AI tell) and drops the old 'always reference a detail' mandate", () => {
    for (const p of [SYSTEM_X_BASE]) {
      const lower = p.toLowerCase();
      // The anti-echo rule is present...
      expect(lower).toContain("ai tell");
      expect(lower).toContain("your point about");
      // ...and the old mandate that produced the echo is gone.
      expect(lower).not.toContain("always reference a specific detail");
      expect(lower).not.toContain("echo a specific phrase");
    }
  });

  it("allows brief standalone reactions without requiring an added explanation", () => {
    for (const prompt of [SYSTEM_X_BASE]) {
      const lower = prompt.toLowerCase();
      expect(lower).toContain("short spoken acknowledgement");
      expect(lower).toContain("so real");
      expect(lower).toContain("token roulette");
      expect(lower).not.toContain("as do standalone acknowledgements");
      expect(lower).toContain("portable generic praise");
      expect(lower).toContain("stays banned");
    }
  });

  // The operator's complaint: "every reply looks like a post". The old text
  // banned the fragment style outright and told the model to glue clauses with
  // commas to reach length, which manufactured 200-char run-ons. These guard
  // the retune so it cannot silently regress.
  describe("X reply voice retune (SYSTEM_X_BASE)", () => {
    const lower = SYSTEM_X_BASE.toLowerCase();

    it("allows shared vocabulary and real source details without parroting coined phrasing", () => {
      expect(lower).toContain("ordinary shared vocabulary");
      expect(lower).toContain("true names and source-specific details");
      expect(lower).not.toContain("delete every word borrowed from their post");
    });

    it("bans the period-stacking RHYTHM without banning fragments themselves", () => {
      expect(lower).toContain("period-stacking");
      expect(lower).toContain("three or more similar-length declaratives");
      // Fragments are now explicitly allowed.
      expect(lower).toContain("fragments");
      expect(lower).not.toContain("avoid the choppy");
    });

    it("does not tell the model to glue clauses to reach length", () => {
      expect(lower).toContain("do not glue clauses");
      // The unqualified licence that produced run-ons is gone.
      expect(SYSTEM_X_BASE).not.toContain("Run-on sentences allowed.");
    });

    it("carries a short length budget instead of the old 250-char ceiling", () => {
      expect(lower).toContain("40-120");
      expect(lower).toContain("hard ceiling 150");
      expect(SYSTEM_X_BASE).not.toContain("≤ 250 chars");
    });

    it("licenses flat disagreement rather than a polite counter-question", () => {
      expect(lower).toContain("push back when you disagree");
      expect(lower).toContain("flat disagreement");
      expect(lower).toContain("a question is not a contrarian angle");
      // ...but bounded, so it does not tip into rudeness.
      expect(lower).toContain("flat is not rude");
    });

    it("bans the softener class the operator called out, and the question-flag openers", () => {
      expect(lower).toContain("gently");
      expect(lower).toContain("respectfully");
      expect(lower).toContain("i'd be curious");
      expect(lower).toContain("genuine question,");
      expect(lower).toContain("honest question,");
    });

    it("bans the late-night-hour prop in every form, not just the observed 1am", () => {
      // Observed the model routing around a narrower ban by changing the hour
      // ("11pm", then "2am"), so the ban names the shape rather than the string.
      expect(lower).toContain("late-night-hour prop in every form");
      expect(lower).toContain("swapping the number does not make it fresh");
    });

    it("bans slang cosplay, so 'more gen z' cannot degrade into caricature", () => {
      expect(lower).toContain("slang cosplay");
      expect(lower).toContain("fr fr");
      expect(lower).toContain("no cap");
    });

    it("overrides the shared OPERATOR BRAND voice notes for replies", () => {
      // brand_config is applied to x_intern, linkedin_intern AND reddit_intern
      // from one shared ~/.noelle/brand.json (apps/cli/src/lib/brand.ts,
      // DRAFTER_ROLES), and `noelle up` rewrites the DB row from that file. So
      // the X reply voice cannot live in brand_config without also retuning
      // Lyra and Orion. It lives here instead, and states its own precedence.
      expect(lower).toContain("except where they conflict");
      expect(lower).toContain("operator brand is shared across platforms");
      expect(lower).toContain("for an x reply, this section wins");
    });

    it("anchors register on real sent X replies, in the target length band", () => {
      expect(lower).toContain("replies the operator actually sent on x");
      expect(lower).toContain("style targets");
      // Every exemplar must itself sit inside the band the prompt asks for,
      // or the block argues against the rule above it.
      const block = SYSTEM_X_BASE.split("REGISTER, IN REPLIES THE OPERATOR ACTUALLY SENT ON X")[1]!
        .split("These are STYLE TARGETS")[0]!;
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(10);
      for (const l of lines) {
        expect(l.length).toBeLessThanOrEqual(90);
      }
    });

    it("keeps the DM exempt from the reply brevity rules", () => {
      expect(lower).toContain("the reply-only rules do not apply to the dm");
      // The DM keeps its own, much longer budget.
      expect(lower).toContain("aim 400 to 700 characters");
    });
  });

  it("keeps the NEVER-DO hard core intact in both prompts (em dash, corporate verbs, echo, English-only, emoji allowlist)", () => {
    for (const p of [SYSTEM_X_BASE]) {
      const lower = p.toLowerCase();
      // Em dashes banned.
      expect(p).toContain("Em dashes");
      // Corporate verbs banned (sample a few).
      expect(lower).toContain("unlock");
      expect(lower).toContain("leverage");
      expect(lower).toContain("streamline");
      // Echo / AI tell banned.
      expect(lower).toContain("echoing the post");
      expect(lower).toContain("ai tell");
      // English-only published replies.
      expect(lower).toContain("english-only");
      // Emoji allowlist preserved.
      expect(p).toContain("💀 😭 😛");
    }
  });

  it("allows an ASSIGNED REGISTER to override length/energy (incl. ALL-CAPS + slang) under the hard rules in both prompts", () => {
    for (const p of [SYSTEM_X_BASE]) {
      expect(p).toContain("ASSIGNED REGISTER FOR THIS REPLY");
      const lower = p.toLowerCase();
      expect(lower).toContain("all-caps");
      expect(lower).toContain("slang");
      // The relaxation never applies to the DM.
      expect(lower).toContain("never applies to the dm");
    }
  });
});

describe("buildDrafterSystem", () => {
  const replyOnly = (brand?: Parameters<typeof buildDrafterSystem>[2]) => buildDrafterSystem(
    null, "Make this account feel heard", brand, null, null, undefined, null, null,
    true, undefined, false, true,
  );

  it("uses reply-only output even without a brand or any appended steering", () => {

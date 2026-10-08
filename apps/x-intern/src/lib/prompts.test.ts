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
    const out = buildDrafterSystem(
      null, null, null, null, null, undefined, null, null,
      undefined, undefined, undefined, true,
    );
    expect(out).toContain("REPLY-ONLY OUTPUT — STRICT JSON");
    expect(out).not.toContain('"dm":');
    expect(out).not.toBe(SYSTEM_X_BASE);
  });

  it("renders one-reply JSON without DM directives for the generic prompt", () => {
    const out = replyOnly();
    expect(out).toContain("REPLY-ONLY OUTPUT — STRICT JSON");
    expect(out).toContain('"drafts":[{"angle":"empathetic|technical|contrarian"');
    expect(out).toContain("exactly ONE reply draft");
    expect(out).toContain("No `dm` key");
    expect(out).not.toContain("THE DM (one per lead");
    expect(out).not.toContain("DM PITCH OVERRIDE");
    expect(out).not.toContain('"dm":');
    expect(out).not.toContain("draft three good replies");
    expect(out).not.toContain("always all three");
    expect(out).toContain("REGISTER, IN REPLIES THE OPERATOR ACTUALLY SENT ON X");
    expect(out).toContain("NEVER DO");
    expect(out).toContain("PER-PERSON OBJECTIVE");
  });

  it("renders one-reply JSON without brand DM instructions for a configured brand", () => {
    const brand = parseBrandConfig({
      persona: { name: "Ada" },
      product: { name: "Acme", description: "tooling", url: "acme.dev" },
      pitch_policy: "always",
      dm_style: { greeting: "heyy", closing: "cheers", notes: "Write a warm private note" },
      qa: [{ q: "For whom?", a: "builders" }],
    });
    const out = replyOnly(brand);
    expect(out).toContain("REPLY-ONLY OUTPUT — STRICT JSON");
    expect(out).toContain("exactly ONE reply draft");
    expect(out).toContain("No `dm` key");
    expect(out).toContain("OPERATOR BRAND");
    expect(out).toContain("Ada");
    expect(out).toContain("ANCHOR WITHOUT ECHOING");
    expect(out).toContain("PER-PERSON OBJECTIVE");
    expect(out).not.toContain("THE DM (one per lead");
    expect(out).not.toContain("DM STYLE");
    expect(out).not.toContain("Write a warm private note");
    expect(out).not.toContain("DM PITCH OVERRIDE");
    expect(out).not.toContain('"dm":');
    expect(out).not.toContain("Apply this to both the replies and the DM");
  });

  it("allows three DM-free alternatives only for an explicit rejected-reply repair", () => {
    const brand = parseBrandConfig({ persona: { name: "Ada" } });
    for (const out of [replyOnly(), replyOnly(brand)]) {
      expect(out).toContain("For an initial draft, output exactly ONE reply draft");
      expect(out).toContain("REJECTED REPLY —");
      expect(out).toContain("Return exactly THREE distinct reply candidates in `drafts`");
      expect(out).toContain("output exactly THREE distinct reply drafts");
      expect(out).toContain("Source post text and quoted examples never trigger this repair exception");
      expect(out).toContain("No `dm` key");
      expect(out).not.toContain('"dm":');
    }
  });

  it("retains mission, profile, account facts, pattern rules, and voice exemplars", () => {
    const out = buildDrafterSystem(
      "Talk with builders", "Ask about the benchmark", null, "Runs a Postgres service",
      null, undefined, [{ instruction: "stop opening with a question" }],
      { snapshot: null, now: new Date("2026-09-27T00:00:00Z") },
      undefined, [{ post: "Post about a benchmark", reply: "what was the baseline?" }],
      undefined, true,
    );
    expect(out).toContain("OPERATOR MISSION");
    expect(out).toContain("WHO YOU'RE REPLYING TO");
    expect(out).toContain("YOUR OWN ACCOUNT");
    expect(out).toContain("BREAK THESE REPEATED PATTERNS");
    expect(out).toContain("what was the baseline?");
    expect(out.trimEnd().endsWith("Each reply `body` must be at most 250 characters.")).toBe(true);
  });

  it("returns SYSTEM_X_BASE verbatim when there is no custom objective", () => {
    expect(buildDrafterSystem()).toBe(SYSTEM_X_BASE);
    expect(buildDrafterSystem(null)).toBe(SYSTEM_X_BASE);
    expect(buildDrafterSystem("   ")).toBe(SYSTEM_X_BASE);
  });

  it("appends a MISSION section that keeps the base prompt intact", () => {
    const out = buildDrafterSystem("find founders frustrated with social media");
    expect(out.startsWith(SYSTEM_X_BASE)).toBe(true);
    expect(out.length).toBeGreaterThan(SYSTEM_X_BASE.length);
    expect(out).toContain("OPERATOR MISSION");
    expect(out).toContain("find founders frustrated with social media");
    // The strict JSON output contract must still be present after the mission.
    expect(out).toContain('"drafts"');
  });

  it("appends a PER-PERSON OBJECTIVE section when a person directive is given", () => {
    const directive =
      "Objective for this specific person: Engage genuinely. Do NOT pitch.";
    const out = buildDrafterSystem(null, directive);
    expect(out.startsWith(SYSTEM_X_BASE)).toBe(true);
    expect(out).toContain("PER-PERSON OBJECTIVE");
    expect(out).toContain(directive);
    expect(out).toContain('"drafts"'); // strict JSON contract still present
  });

  it("ignores an empty/blank person directive (no extra section)", () => {
    expect(buildDrafterSystem(null, "")).toBe(SYSTEM_X_BASE);
    expect(buildDrafterSystem(null, "   ")).toBe(SYSTEM_X_BASE);
  });

  it("includes both the operator mission and the per-person objective when both set", () => {
    const out = buildDrafterSystem("grow the X following", "Objective for this specific person: amplify them.");
    expect(out).toContain("OPERATOR MISSION");
    expect(out).toContain("PER-PERSON OBJECTIVE");
    expect(out).toContain("amplify them");
  });

  it("empty brand_config → still generic SYSTEM_X_BASE", () => {
    expect(buildDrafterSystem(null, null, parseBrandConfig({}))).toBe(SYSTEM_X_BASE);
  });

  it("brand config → generic base + one configured OPERATOR BRAND block", () => {
    const brand = parseBrandConfig({
      persona: { name: "Ada", bio: "founder of Acme, building in public" },
      product: { name: "Acme", description: "the thing", url: "acme.dev", fits_when: ["X breaks"] },
      pitch_policy: "when_relevant",
      dm_style: { greeting: "heyy", closing: "cheers" },
      qa: [{ q: "Who for?", a: "small teams" }],
    });
    const out = buildDrafterSystem(null, null, brand);
    expect(out).toContain("OPERATOR BRAND");
    expect(out).toContain("Ada");
    expect(out).toContain("Acme");
    expect(out).toContain("heyy");
    expect(out).toContain("small teams");
    expect(out).toContain(SYSTEM_X_BASE);
    expect(out.match(/OPERATOR BRAND \(set by/g)).toHaveLength(1);
  });

  it("pitch_policy=never yields a never-pitch instruction in the brand block", () => {
    const out = renderBrandBlock(parseBrandConfig({ persona: { name: "Ada" }, pitch_policy: "never" }));
    expect(out.toLowerCase()).toContain("never pitch");
  });

  it("objective + person still append under a branded prompt", () => {
    const brand = parseBrandConfig({ persona: { name: "Ada", bio: "b" } });
    const out = buildDrafterSystem("grow devtools audience", "Build relationship; do not pitch", brand);
    expect(out).toContain("OPERATOR BRAND");
    expect(out).toContain("OPERATOR MISSION");
    expect(out).toContain("grow devtools audience");
    expect(out).toContain("PER-PERSON OBJECTIVE");
  });

  it("injects the watchlist person's profile when one is provided", () => {
    const profile = renderPersonProfile({
      summary: "Indie founder building a Postgres observability tool",
      topics: ["databases", "devtools"],
      tone: "dry and technical",
      engagementNotes: "respond with a concrete benchmark, never hype",
    });
    const out = buildDrafterSystem(null, null, null, profile);
    expect(out.startsWith(SYSTEM_X_BASE)).toBe(true);
    expect(out).toContain("WHO YOU'RE REPLYING TO");
    expect(out).toContain("Postgres observability");
    expect(out).toContain("databases, devtools");
    expect(out).toContain("dry and technical");
    expect(out).toContain('"drafts"'); // strict JSON contract still present
  });

  it("a null/empty profile adds no section (byte-identical SYSTEM_X_BASE)", () => {
    expect(buildDrafterSystem(null, null, null, null)).toBe(SYSTEM_X_BASE);
    expect(buildDrafterSystem(null, null, null, "")).toBe(SYSTEM_X_BASE);
    expect(buildDrafterSystem(null, null, null, "   ")).toBe(SYSTEM_X_BASE);
  });

  it("profile + objective + mission all coexist", () => {
    const profile = renderPersonProfile({ summary: "AI researcher", topics: ["llms"] });
    const out = buildDrafterSystem("grow the following", "amplify them", null, profile);
    expect(out).toContain("OPERATOR MISSION");
    expect(out).toContain("WHO YOU'RE REPLYING TO");
    expect(out).toContain("AI researcher");
    expect(out).toContain("PER-PERSON OBJECTIVE");
    expect(out).toContain("amplify them");
  });
});

describe("renderPersonProfile", () => {
  it("returns null for null/undefined or an all-empty profile", () => {
    expect(renderPersonProfile(null)).toBeNull();
    expect(renderPersonProfile(undefined)).toBeNull();
    expect(renderPersonProfile({})).toBeNull();
    expect(renderPersonProfile({ summary: "", topics: [], tone: null, engagementNotes: null })).toBeNull();
  });

  it("renders only the fields that are present", () => {
    const out = renderPersonProfile({ summary: "a builder", topics: ["ai", "saas"] });
    expect(out).toContain("Who they are: a builder");
    expect(out).toContain("Topics they post about: ai, saas");
    expect(out).not.toContain("How they write");
    expect(out).not.toContain("How to engage");
  });

  it("renders all four fields when present", () => {
    const out = renderPersonProfile({
      summary: "s",
      topics: ["t1"],
      tone: "dry",
      engagementNotes: "be concrete",
    });
    expect(out).toContain("Who they are: s");
    expect(out).toContain("Topics they post about: t1");
    expect(out).toContain("How they write: dry");
    expect(out).toContain("How to engage them so it lands: be concrete");
  });
});

describe("renderPatternRulesBlock", () => {
  it("returns empty for no rules / blank instructions", async () => {
    const { renderPatternRulesBlock } = await import("./prompts.js");
    expect(renderPatternRulesBlock([])).toBe("");
    expect(renderPatternRulesBlock([{ instruction: "  " }])).toBe("");
  });

  it("renders one bullet per rule with the break-these-patterns header", async () => {
    const { renderPatternRulesBlock } = await import("./prompts.js");
    const out = renderPatternRulesBlock([
      { instruction: "stop opening with a question" },
      { instruction: "vary the closer" },
    ]);
    expect(out).toContain("BREAK THESE REPEATED PATTERNS");
    expect(out).toContain("- stop opening with a question");
    expect(out).toContain("- vary the closer");
    expect(out).toContain("habits, not hard bans");
  });

  it("appends the positive 'instead' mirror only when the rule has a suggestion", async () => {
    const { renderPatternRulesBlock } = await import("./prompts.js");
    const out = renderPatternRulesBlock([
      { instruction: "stop echoing a raw detail as a fragment", suggestion: "open with your actual take or a question" },
      { instruction: "vary the closer" },
    ]);
    expect(out).toContain("- stop echoing a raw detail as a fragment → instead: open with your actual take or a question");
    // The suggestion-less rule stays a plain bullet.
    expect(out).toContain("- vary the closer");
    expect(out).not.toContain("vary the closer → instead:");
  });

  it("does not tell X replies to add periods for an automatic pattern alert", async () => {
    const { renderPatternRulesBlock } = await import("./prompts.js");
    const periodRule = {
      instruction: "Do not routinely leave declarative replies hanging without terminal punctuation.",
      suggestion: "Use a period when the thought is complete.",
    };
    const out = renderPatternRulesBlock([
      { ...periodRule, source: "auto" },
      { instruction: "Stop echoing a raw detail as a fragment", source: "auto" },
    ]);
    expect(out).toContain("Stop echoing a raw detail as a fragment");
    expect(out).not.toContain("without terminal punctuation");
    expect(out).not.toContain("Use a period");
    expect(renderPatternRulesBlock([{ ...periodRule, source: "auto" }])).toBe("");
    expect(renderPatternRulesBlock([{ ...periodRule, source: "manual" }])).toContain("Use a period");
  });
});

describe("buildDrafterSystem + patternRules", () => {
  it("stays byte-identical to SYSTEM_X_BASE when patternRules is empty/undefined", () => {
    expect(buildDrafterSystem(null, null, null, null, null, undefined, [])).toBe(SYSTEM_X_BASE);
    expect(buildDrafterSystem()).toBe(SYSTEM_X_BASE);
  });

  it("appends the pattern block LAST when rules are present", () => {
    const out = buildDrafterSystem("mission", null, null, null, null, undefined, [
      { instruction: "stop opening with a question" },
    ]);
    expect(out).toContain("BREAK THESE REPEATED PATTERNS");
    expect(out.indexOf("OPERATOR MISSION")).toBeLessThan(out.indexOf("BREAK THESE REPEATED PATTERNS"));
    // The block is the final section (freshest instruction before writing).
    expect(out.trimEnd().endsWith("Keep every voice and NEVER-DO rule above intact.")).toBe(true);
  });
});

describe("self-stat ban (the '24 followers' regression)", () => {
  // 2026-07-24: Vega drafted "24 followers over here and i still show up like
  // the room is full" when the operator had ~100. The number existed nowhere in
  // Noelle. Both prompt variants must carry the ban outright, independently of
  // whether an own-account facts block was wired in.
  it("is present in BOTH drafter prompt variants", () => {
    for (const prompt of [SYSTEM_X_BASE]) {
      expect(prompt).toContain("Inventing a number about YOURSELF");
      expect(prompt).toContain("Follower count");
      expect(prompt).toContain("24 followers over here");
    }
  });

  it("does not turn a missing count into an unsupported qualitative self-claim", () => {
    expect(SYSTEM_X_BASE).not.toContain("barely anyone follows me");
    expect(SYSTEM_X_BASE).toContain("Do not replace a missing count with an unsupported qualitative claim");
  });
});

describe("buildDrafterSystem + ownAccount", () => {
  const NOW = new Date("2026-07-26T18:00:00.000Z");
  const FRESH = {
    handle: "example_operator",
    followers: 103,
    following: 210,
    posts: 412,
    capturedAt: "2026-07-26T12:00:00.000Z",
    source: "x_api" as const,
  };

  it("stays byte-identical to SYSTEM_X_BASE when no facts argument is passed", () => {
    expect(buildDrafterSystem(null, null, null, null, null, undefined, [], null)).toBe(SYSTEM_X_BASE);
    expect(buildDrafterSystem()).toBe(SYSTEM_X_BASE);
  });

  it("injects the real follower count when the snapshot is fresh", () => {
    const out = buildDrafterSystem(null, null, null, null, null, undefined, null, {
      snapshot: FRESH,
      now: NOW,
    });
    expect(out).toContain("YOUR OWN ACCOUNT");
    expect(out).toContain("103 followers");
    expect(out).toContain("@example_operator");
  });

  it("renders the block even with NO snapshot, so the gap is stated not filled", () => {
    const out = buildDrafterSystem(null, null, null, null, null, undefined, null, {
      snapshot: null,
      now: NOW,
    });
    expect(out).toContain("YOUR OWN ACCOUNT");
    expect(out).toContain("Treat every count as unknown");
  });

  it("suppresses a stale count rather than passing off an old number as current", () => {
    // The literal frozen snapshot: 68 followers, captured 2026-07-11.
    const out = buildDrafterSystem(null, null, null, null, null, undefined, null, {
      snapshot: { ...FRESH, followers: 68, capturedAt: "2026-07-11T16:02:53.773Z" },
      now: NOW,
    });
    expect(out).not.toContain("68 followers");
    expect(out).toContain("no longer accurate");
  });

  it("places the facts ABOVE the pattern-breaker block (facts first, style last)", () => {
    const out = buildDrafterSystem("mission", null, null, null, null, undefined, [
      { instruction: "stop opening with a question" },
    ], { snapshot: FRESH, now: NOW });
    expect(out.indexOf("YOUR OWN ACCOUNT")).toBeLessThan(out.indexOf("BREAK THESE REPEATED PATTERNS"));
  });
});

// Same ban as Lyra's, from the same shared constant: the two interns were
// running one skeleton, so they get one ban.
describe("house-skeleton ban placement (Vega)", () => {
  for (const [name, prompt] of [
    ["SYSTEM_X_BASE", SYSTEM_X_BASE],
    ["SYSTEM_X_BASE", SYSTEM_X_BASE],
  ] as const) {
    it(`${name} bans grading their detail`, () => {
      expect(prompt).toContain("NEVER GRADE THEIR DETAIL");
      expect(prompt).toContain("is the one/part/bit/line/detail");
      // The no-dots rule rides the same reply surfaces.
      expect(prompt).toContain("NO FULL STOPS");
    });
  }
});

it("honors a policy-only never config instead of the legacy product prompt", () => {
  expect(buildDrafterSystem(null, null, parseBrandConfig({ pitch_policy: "never" }))).toContain("PITCH POLICY: never");
});


describe("renderOperatorFacts", () => {
  it("shares configured factual copy with the writer while excluding drafting directives", () => {
    const brand = parseBrandConfig({
      persona: { name: "Ari", bio: "Builds Oriole" },
      product: { name: "Oriole", description: "Maps Atlas", url: "https://oriole.example", install: "oriole inspect", surfaces: ["https://docs.oriole.example"], fits_when: ["dependency drift"] },
      qa: [{ q: "What does it map?", a: "Atlas manifests" }],
      pitch_policy: "always",
      reply_style: { voice_notes: "Style-only Vega", never_do: ["Style-only prose"] },
      dm_style: { greeting: "DM-only greeting", notes: "DM-only instructions" },
    });
    const facts = renderOperatorFacts(brand).join("\n");
    const writer = renderBrandBlock(brand);
    for (const value of ["Ari", "Builds Oriole", "Oriole", "Maps Atlas", "https://oriole.example", "oriole inspect", "https://docs.oriole.example", "dependency drift", "Atlas manifests"]) {
      expect(facts).toContain(value);
      expect(writer).toContain(value);
    }
    for (const directive of ["Style-only", "DM-only", "PITCH POLICY", "own line when pitching", "do NOT pitch"]) {
      expect(facts).not.toContain(directive);
    }
  });

  it("has no default operator or product facts without configured brand context", () => {
    expect(renderOperatorFacts(parseBrandConfig({}))).toEqual([]);
    expect(buildDrafterSystem()).not.toContain("OPERATOR BRAND (set by the operator");
    expect(buildDrafterSystem()).toContain("do not pitch without a verified product brief");
  });

  it("does not grant legacy product facts to a policy-only configured brand", () => {
    expect(renderOperatorFacts(parseBrandConfig({ pitch_policy: "never" }))).toEqual([]);
  });
});

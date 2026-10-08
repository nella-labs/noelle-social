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
      const lower = p.toLowerCase();
      // the rule still names honestly...
      expect(lower).toContain('"honestly"');
      // ...but now permits it as occasional natural texture (matching the X prompt),
      // rather than banning the word outright — that hard ban was a driver of the
      // stiff/corporate read the LinkedIn replies had.
      expect(lower).toMatch(/single natural "honestly"|texture is fine/);
      // ...while still forbidding the throat-clearing hedge-opener / verbal tic.
      expect(lower).toMatch(/hedge-opener|verbal tic/);
    }
  });
});

describe("renderStyleBlock is post-register aware", () => {
  it("celebration → instructs a warm/hyped BLEND, not a neutral form-match", () => {
    const block = renderStyleBlock(sampleStyle, "celebration");
    const lower = block.toLowerCase();
    expect(lower).toContain("celebrating");
    expect(lower).toMatch(/warm|hyped|excited/);
    expect(lower).toContain("blend");
    // FORM discipline survives: no fabrication, exemplars still rendered
    expect(lower).toContain("fabricate");
    expect(block).toContain("omg congrats this is amazing!!!");
  });

  it("neutral → forbids forced cheer, keeps the substantive voice", () => {
    const block = renderStyleBlock(sampleStyle, "neutral");
    const lower = block.toLowerCase();
    expect(lower).toMatch(/analytical|not a celebration/);
    expect(lower).toMatch(/reads fake|do not add cheering|forced excitement/);
    // exemplars still rendered (form is still taught)
    expect(block).toContain("omg congrats this is amazing!!!");
  });

  it("omitting the register → the legacy generic FORM block", () => {
    const block = renderStyleBlock(sampleStyle);
    expect(block).toContain("match the FORM, not the content");
    expect(block.toLowerCase()).not.toContain("celebrating");
  });

  it("empty style → empty string (prompt stays unchanged)", () => {
    expect(renderStyleBlock({ exemplars: [], styleNotes: "" }, "celebration")).toBe("");
  });
});

describe("buildDrafterSystem threads the post register into the STYLE block", () => {
  it("includes sent reply exemplars when they are the only optional context", () => {
    const exemplars = [{ post: "The approval handoff takes a day", reply: "That handoff is where the queue piles up" }];
    const system = buildDrafterSystem(null, null, null, null, undefined, null, false, exemplars);
    expect(system).toContain(exemplars[0]!.post);
    expect(system).toContain(exemplars[0]!.reply);
    expect(system.slice(0, drafterSystemCachePrefixLen(null))).toBe(SYSTEM_LINKEDIN_BASE);
    expect(buildDrafterSystem(null, null, null, null, undefined, null, false, [])).toBe(SYSTEM_LINKEDIN_BASE);
  });

  it("a celebration register reaches the rendered prompt", () => {
    const sys = buildDrafterSystem("obj", "person", null, sampleStyle, "celebration");
    expect(sys.toLowerCase()).toContain("celebrating");
  });

  it("a neutral register renders the no-forced-cheer guidance", () => {
    const sys = buildDrafterSystem("obj", "person", null, sampleStyle, "neutral");
    expect(sys.toLowerCase()).toMatch(/reads fake|not a celebration/);
  });
});

describe("buildDrafterSystem injects Pattern Breaker rules", () => {
  const rules = [
    { instruction: "Do not end a substantive post with a bare 'congrats'; end on the actual point." },
    { instruction: "Vary your opener; you keep leading with a one-line hook then a blank line." },
  ];

  it("renders the BREAK THESE REPEATED PATTERNS block with each instruction", () => {
    const sys = buildDrafterSystem("obj", "person", null, null, undefined, rules);
    expect(sys).toContain("BREAK THESE REPEATED PATTERNS");
    expect(sys).toContain("bare 'congrats'");
    expect(sys).toContain("Vary your opener");
  });

  it("omits the block entirely when there are no rules", () => {
    const sys = buildDrafterSystem("obj", "person", null, null, undefined, []);
    expect(sys).not.toContain("BREAK THESE REPEATED PATTERNS");
  });

  it("omits an auto terminal-punctuation rule that conflicts with public reply style", () => {
    const instruction = "Do not habitually leave replies without terminal punctuation.";
    const auto = buildDrafterSystem("obj", "person", null, null, undefined,
      [{ instruction, source: "auto" }]);
    expect(auto).not.toContain(instruction);
    expect(auto).not.toContain("BREAK THESE REPEATED PATTERNS");
    const confirmed = buildDrafterSystem("obj", "person", null, null, undefined,
      [{ instruction, source: "manual" }]);
    expect(confirmed).toContain(instruction);
  });

  it("appends the positive 'instead' mirror to a rule that has a suggestion", () => {
    const sys = buildDrafterSystem("obj", "person", null, null, undefined, [
      { instruction: "Do not open with a raw-detail fragment.", suggestion: "Open with your actual take or a question." },
    ]);
    expect(sys).toContain("→ instead: Open with your actual take or a question.");
    // A rule without a suggestion stays a plain bullet (no trailing arrow).
    const plain = buildDrafterSystem("obj", "person", null, null, undefined, [{ instruction: "Vary your opener." }]);
    expect(plain).toContain("- Vary your opener.");
    expect(plain).not.toContain("→ instead:");
  });
});

describe("drafterSystemCachePrefixLen is a real prefix of buildDrafterSystem", () => {
  it("no-brand: prefix len === SYSTEM_LINKEDIN_BASE.length and the output starts with it", () => {
    const sys = buildDrafterSystem("mission x", "person y", null);
    expect(sys.startsWith(SYSTEM_LINKEDIN_BASE)).toBe(true);
    expect(drafterSystemCachePrefixLen(null)).toBe(SYSTEM_LINKEDIN_BASE.length);
    // The computed prefix is a byte-exact prefix of the full system (the
    // load-bearing invariant: a wrong len silently kills cache hits).
    expect(sys.slice(0, drafterSystemCachePrefixLen(null))).toBe(SYSTEM_LINKEDIN_BASE);
  });

  it("brand: prefix is renderBrandBlock + blank + SYSTEM_LINKEDIN_BASE, a real prefix of the output", () => {
    const brand: BrandConfig = {
      persona: { name: "Ada", bio: "builder of things" },
      product: { name: "Widget", description: "does widget stuff", surfaces: [], fits_when: [] },
      pitch_policy: "when_relevant",
      qa: [],
    };
    const sys2 = buildDrafterSystem("mission x", "person y", brand);
    const expectedPrefix = [renderBrandBlock(brand), "", SYSTEM_LINKEDIN_BASE].join("\n");
    expect(drafterSystemCachePrefixLen(brand)).toBe(expectedPrefix.length);
    expect(sys2.slice(0, drafterSystemCachePrefixLen(brand))).toBe(expectedPrefix);
    expect(sys2.startsWith(expectedPrefix)).toBe(true);
  });

  it("falls back to the no-brand prefix when brand_config has no content", () => {
    expect(drafterSystemCachePrefixLen({} as BrandConfig)).toBe(SYSTEM_LINKEDIN_BASE.length);
  });
});

// ---- anti-ai skill rules reach every Lyra prose surface --------------------
// The deterministic half lives in scoreFormat (@noelle/runtime); this asserts the
// proactive half is actually IN the prompts. A rule that exists only in the
// verifier just burns regenerates.
describe("anti-ai rules are injected into every Lyra system prompt", () => {
  const SURFACES: Array<[string, string]> = [
    ["SYSTEM_LINKEDIN_BASE", SYSTEM_LINKEDIN_BASE],
    ["SYSTEM_LINKEDIN_BASE", SYSTEM_LINKEDIN_BASE],
    ["SYSTEM_LINKEDIN_LIGHT", SYSTEM_LINKEDIN_LIGHT],
  ];
  for (const [name, prompt] of SURFACES) {
    it(`${name} bans significance-marking meta commentary`, () => {
      expect(prompt).toMatch(/NEVER MARK SIGNIFICANCE/);
      expect(prompt).toContain("here's the thing");
      expect(prompt).toContain("let that sink in");
    });
    it(`${name} names the reader-mode constructions`, () => {
      expect(prompt).toMatch(/Rule of three/i);
      expect(prompt).toMatch(/Copula dodge/i);
      expect(prompt).toMatch(/Vague authority/i);
      expect(prompt).toMatch(/Participial tails/i);
    });
    it(`${name} carries the tier-1 wordbank`, () => {
      expect(prompt).toMatch(/TIER-1 VOCABULARY/);
      for (const w of ["delve", "leverage", "tapestry", "seamless", "myriad"]) {
        expect(prompt).toContain(w);
      }
    });
    it(`${name} keeps the fixate-don't-cover + grounding rules`, () => {
      expect(prompt).toMatch(/FIXATE, DON'T COVER/);
      expect(prompt).toMatch(/GROUND IT IN THE REAL/);
    });
  }

  // The anti-ai skill's DETECTOR mode needs invented names/prices/dialogue as
  // scaffolding. Lyra auto-queues drafts with no swap-in step, so the
  // no-fabrication ban must still win. If a future change adopts discourse
  // fracture, this test should fail loudly and force the decision.
  it("does not weaken the no-fabrication ban", () => {
    expect(SYSTEM_LINKEDIN_BASE).toMatch(/Invent personal history \(HARD BAN/);
    expect(SYSTEM_LINKEDIN_BASE).toMatch(/Invent personal history \(HARD BAN/);
    expect(SYSTEM_LINKEDIN_LIGHT).toMatch(/Do NOT invent personal history/);
  });

  // Detector-mode's "no punchlines, flat complaints only" would kill the
  // register-matching Lyra was explicitly tuned for. Assert it survived.
  it("keeps register-matching (detector-mode flatness was NOT adopted)", () => {
    expect(SYSTEM_LINKEDIN_BASE).toMatch(/MATCH THE ENERGY/);
    expect(SYSTEM_LINKEDIN_BASE).toMatch(/dry humor when the line earns it/);
  });
});

// The anti-ai rules share a prompt with the assigned FORM VARIANTS
// (@noelle/runtime FORM_VARIANTS). Three variants steer toward moves the rules
// appear to ban, so the reconciliations must stay in the prompt:
//   THREE_BEAT   -> "reaction, concrete point, closing thought" vs rule-of-three
//   QUESTION_ONLY-> "the whole reply is ONE question"           vs rhetorical Q&A
//   DETAIL_ZOOM  -> "say why it stuck with you"                 vs significance markers
describe("anti-ai rules do not contradict the assigned form variants", () => {
  it("scopes rule-of-three to lists, not to sentence count (THREE_BEAT)", () => {
    expect(SYSTEM_LINKEDIN_BASE).toMatch(/about LISTS, not about how many sentences/);
  });
  it("keeps genuinely asking a question allowed (QUESTION_ONLY)", () => {
    expect(SYSTEM_LINKEDIN_BASE).toMatch(/Genuinely ASKING them something you actually want to know/);
  });
  it("tells the writer how to satisfy DETAIL_ZOOM without a significance marker", () => {
    expect(SYSTEM_LINKEDIN_BASE).toMatch(/ASSIGNED SHAPE asks you to zoom in on one detail/);
    expect(SYSTEM_LINKEDIN_BASE).toMatch(/Show which part mattered by spending the words on it/);
  });
});

// docs/linkedin-intern.md claims the rules reach "all five prose surfaces".
// The three reply surfaces are asserted above; these are the two DM surfaces,
// which were previously unpinned.
describe("anti-ai rules reach both DM surfaces too", () => {
  it("permits an optional rung-four call without inferring a warm relationship from outbound DMs", () => {
    const prompt = buildLadderDmSystem({
      index: 4, id: "invite", label: "Invite", proposesCall: true, directive: "Allow one optional invite",
    });
    const policy = prompt.split("\n").find((line) => line.startsWith("CALL POLICY:"));
    expect(policy).toContain("Prior outbound DMs do not prove a response or relationship");
    expect(policy).toContain("recorded received evidence");
    expect(policy).toContain("ONE low-pressure, easy-to-decline quick call");
    expect(policy).not.toContain("warm enough");
  });

  const LADDER = buildLadderDmSystem({
    index: 1,
    id: "open",
    label: "Open",
    proposesCall: false,
    directive: "open the relationship",
  });
  for (const [name, prompt] of [
    ["SYSTEM_LINKEDIN_INTRO", SYSTEM_LINKEDIN_INTRO],
    ["buildLadderDmSystem", LADDER],
  ] as const) {
    it(`${name} carries the anti-ai rules`, () => {
      expect(prompt).toMatch(/NEVER MARK SIGNIFICANCE/);
      expect(prompt).toMatch(/TIER-1 VOCABULARY/);
      expect(prompt).toContain("let that sink in");
    });
  }
});

// The house skeleton ("lift a detail out of their post, make it the subject,
// attach a verdict") measured ~55% of Lyra's live drafts. The ban belongs on
// every REPLY surface and on none of the DM surfaces: a DM is a different
// register and the frames are not a tell there.
describe("house-skeleton ban placement", () => {
  for (const [name, prompt] of [
    ["SYSTEM_LINKEDIN_BASE", SYSTEM_LINKEDIN_BASE],
    ["SYSTEM_LINKEDIN_BASE", SYSTEM_LINKEDIN_BASE],
    ["SYSTEM_LINKEDIN_LIGHT", SYSTEM_LINKEDIN_LIGHT],
  ] as const) {
    it(`${name} bans grading their detail`, () => {
      expect(prompt).toContain("NEVER GRADE THEIR DETAIL");
      expect(prompt).toContain("is the one/part/bit/line/detail");
      // The no-dots rule rides the same reply surfaces.
      expect(prompt).toContain("NO FULL STOPS");
    });
  }

  for (const [name, prompt] of [
    ["SYSTEM_LINKEDIN_INTRO", SYSTEM_LINKEDIN_INTRO],
    ["buildLadderDmSystem", buildLadderDmSystem({
      index: 1, id: "open", label: "Open", proposesCall: false, directive: "open the relationship",
    })],
  ] as const) {
    it(`${name} does NOT carry the reply-only skeleton ban`, () => {
      expect(prompt).not.toContain("NEVER GRADE THEIR DETAIL");
      expect(prompt).not.toContain("NO FULL STOPS");
    });
  }
});

it("honors a policy-only never config instead of the legacy product prompt", () => {
  expect(buildDrafterSystem(null, null, { pitch_policy: "never", qa: [] })).toContain("PITCH POLICY: never");
});


it("requires configured identity and product facts for unbranded drafting", () => {
  const prompt = buildDrafterSystem();
  expect(prompt).toContain("do not pitch without a verified product brief");
  expect(prompt).not.toContain("OPERATOR BRAND (set by the operator");
});

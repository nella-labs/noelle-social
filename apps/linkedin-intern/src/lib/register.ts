// Voice-variety registers for the LinkedIn drafter (Lyra).
//
// PROBLEM: LLMs ignore a vague "be varied" — every comment converges on the same
// medium-length "smart analytical peer" shape. So instead of asking for variety,
// we INJECT actual randomness: per lead, we pick ONE register from a weighted set
// and inject its directive into the comment-drafting prompt, so THIS lead's
// comments take on that register (ultra-short, hype, slang, punchy, or the normal
// default). Across the feed the registers visibly vary; within a single lead the
// comments share one register so they read like one person in one mood.
//
// Pure + unit-testable: pickRegister takes an injectable rng (default
// Math.random; using Math.random in worker code is fine). The whole mechanism is
// gated behind NOELLE_DRAFTER_VARIETY (env.ts, default OFF) — when off, no
// register is injected and drafts are byte-identical to today. Applies to BOTH
// the substantial and light comment paths; NOT the DM / intro-DM paths.
//
// Deliberately mirrored from apps/x-intern/src/lib/register.ts (the two apps
// don't share app-lib code). Keep the two in sync.

export type RegisterId = "ULTRA_SHORT" | "HYPE" | "SLANG" | "PUNCHY" | "NORMAL";

export interface Register {
  id: RegisterId;
  /** Weight in (0,1]; the weights across all registers sum to 1. */
  weight: number;
  /** The "ASSIGNED REGISTER" directive injected into the comment-drafting prompt. */
  directive: string;
}

// The curated register set. Weights are tuned so NORMAL does NOT dominate —
// variety must be visible across the feed. NORMAL is the homogenizing register
// (everything that lands there converges on the same "smart analytical peer"
// shape and the feed reads identical), so it's held down to 0.20 and the more
// distinctive registers fire more often. They sum to 1.00 exactly:
//   ULTRA_SHORT 0.24 + HYPE 0.12 + SLANG 0.24 + PUNCHY 0.20 + NORMAL 0.20 = 1.00
export const REGISTERS: Register[] = [
  {
    id: "ULTRA_SHORT",
    weight: 0.24,
    directive:
      "Reply in 3-7 words, one punchy reaction, no setup. e.g. 'this is huge', 'okay this slaps', 'the dream tbh', 'absolute cinema'. Keep every comment this short.",
  },
  {
    id: "HYPE",
    weight: 0.12,
    directive:
      "React with real excitement, CAPS + exclamations welcome ('YESSS', 'LETS GOOO', 'CONGRATS man!!', 'absolute GOAT', 'huge W'), slang welcome, keep it short. IF the post is NOT actually a win/launch/milestone/celebration, ignore this register and react normally.",
  },
  {
    id: "SLANG",
    weight: 0.24,
    directive:
      "Loose, lowercase, like texting a friend. jerga/slang ok (tbh, ngl, lowkey, fr, that's wild, no shot). One or two lines.",
  },
  {
    id: "PUNCHY",
    weight: 0.2,
    directive:
      "One sharp sentence with a real opinion. No hedging, no preamble.",
  },
  {
    id: "NORMAL",
    weight: 0.2,
    directive:
      "A smart, specific peer comment, the default register. A real take, proportionate to the post. Vary your opening and word choice — do not reach for the same stock phrasings every time.",
  },
];

/**
 * Pick ONE register for a lead by weighted random choice. `rng` is injectable so
 * the choice is deterministic in tests; production passes Math.random. The
 * registers are walked in REGISTERS order and the first whose cumulative weight
 * exceeds r wins, so a stubbed r maps to a known register (see register.test.ts).
 * A pathological r >= sum (or NaN) falls back to the last register (NORMAL).
 */
export function pickRegister(rng: () => number = Math.random): Register {
  const r = rng();
  let cumulative = 0;
  for (const register of REGISTERS) {
    cumulative += register.weight;
    if (r < cumulative) return register;
  }
  return REGISTERS[REGISTERS.length - 1]!;
}

/**
 * Render the "ASSIGNED REGISTER" block injected into the comment-drafting prompt.
 * Kept here (next to the registers) so both the worker and tests share one
 * source of truth for the wording the prompt looks for.
 */
export function renderRegisterBlock(register: Register): string {
  return [
    "ASSIGNED REGISTER FOR THIS REPLY (applies to the comment(s), NOT the DM)",
    register.directive,
    "This register overrides the default length/energy for the comments only, so follow it, including ALL-CAPS, exclamations, very short fragments, and slang where it calls for them. Keep every other rule (no em dashes, no corporate verbs, no reframe/negative-parallelism, no echoing the post, English only, the emoji allowlist) fully intact. This never applies to the DM.",
  ].join("\n");
}

// ---- Post register (celebration vs neutral) --------------------------------
// The Account Feeder's STYLE injection and the variety register both want ONE
// fact about the post being replied to: is it a CELEBRATION (a win, launch,
// milestone, happy announcement) or a NEUTRAL post (analysis, opinion, a
// question, a vent)? A cheering, hyped, exclamation-heavy register is right on a
// celebration and reads fake on a serious post. The classifier already encodes
// this: it labels wins/launches/milestones 'light'. We trust that label first
// and fall back to a cheap text heuristic only when no label is present.

export type PostRegister = "celebration" | "neutral";

// Strong, unambiguous celebration signals in the post text. Deliberately narrow
// (announcement verbs + congrats + clearly-happy framings) so an analytical post
// that merely mentions a launch isn't misread as a celebration.
const CELEBRATION_SIGNALS =
  /\b(congrats|congratulations|thrilled to|excited to (share|announce)|happy to (share|announce)|proud to (share|announce)|stoked to|pumped to|we (just )?(launched|shipped|raised|closed|hit)|i (just )?(launched|shipped|joined|raised|started|got)|just (launched|shipped|went live)|officially live|big news|day one|landed (a|my|the) (job|role|offer|gig))\b/i;

// Genuinely celebratory emoji (not the generic 🚀🔥 that show up everywhere).
const CELEBRATION_EMOJI = /[🎉🥳🙌👏🎊🍾]/u;

function looksCelebratory(text: string): boolean {
  if (!text) return false;
  if (CELEBRATION_SIGNALS.test(text)) return true;
  // An emoji party plus an exclamation is a celebration even without keywords.
  const exclaims = (text.match(/!/g) ?? []).length;
  return CELEBRATION_EMOJI.test(text) && exclaims >= 1;
}

/**
 * Decide the post's register. The classifier label is AUTHORITATIVE: 'light'
 * means the upstream grader already judged this a win/launch/milestone, so it's
 * a celebration; any other non-empty label means it judged the post substantive,
 * so it's neutral (we do NOT override the classifier with a keyword guess). Only
 * when there is NO label do we fall back to the text heuristic.
 */
export function detectPostRegister(
  postText: string,
  classifierLabel?: string | null,
): PostRegister {
  if (classifierLabel === "light") return "celebration";
  if (classifierLabel && classifierLabel.trim().length > 0) return "neutral";
  return looksCelebratory(postText) ? "celebration" : "neutral";
}

// ---- Post-register-aware register selection --------------------------------
// pickRegister() picks from the full weighted set blind to the post. But HYPE
// (CAPS + "LETS GOOO") is only ever right on a celebration, and a measured
// analytical post should never be assigned it. So when we know the post's
// register we pick from a register subset tuned to it: celebration leans HARD
// into HYPE + warm short forms; neutral drops HYPE entirely.

function withWeight(id: RegisterId, weight: number): Register {
  const base = REGISTERS.find((r) => r.id === id)!;
  return { ...base, weight };
}

/** The register subset to sample from for a given post register. */
export function registersForPost(postRegister: PostRegister): Register[] {
  if (postRegister === "celebration") {
    // HYPE dominates; the warm short forms back it up; a little NORMAL for range.
    // (Weights are renormalized inside pickRegisterForPost, so they need not sum to 1.)
    return [
      withWeight("HYPE", 0.5),
      withWeight("ULTRA_SHORT", 0.25),
      withWeight("SLANG", 0.15),
      withWeight("NORMAL", 0.1),
    ];
  }
  // neutral → everything EXCEPT HYPE (no manufactured excitement on a serious post).
  return REGISTERS.filter((r) => r.id !== "HYPE");
}

/**
 * Pick ONE register for a lead, conditioned on the post's register. Same weighted
 * walk as pickRegister but over registersForPost(postRegister), with the subset's
 * weights renormalized so the pick is well-defined. rng is injectable for tests.
 */
export function pickRegisterForPost(
  postRegister: PostRegister,
  rng: () => number = Math.random,
): Register {
  const set = registersForPost(postRegister);
  const total = set.reduce((acc, r) => acc + r.weight, 0);
  const r = rng() * total;
  let cumulative = 0;
  for (const register of set) {
    cumulative += register.weight;
    if (r < cumulative) return register;
  }
  return set[set.length - 1]!;
}

// Voice-variety registers + post-ENERGY detection, shared by the X (Vega) and
// Reddit (Orion) drafters via @noelle/runtime/register.
//
// TWO jobs live here:
//
// 1. VOICE-VARIETY REGISTERS. LLMs ignore a vague "be varied" — every reply
//    converges on the same medium-length "smart analytical peer" shape. So instead
//    of asking for variety we INJECT a register: per lead we pick ONE register from
//    a weighted set and inject its directive, so this lead's reply takes on that
//    register (ultra-short, hype, slang, punchy, deadpan, or the normal default).
//    Gated behind NOELLE_DRAFTER_VARIETY.
//
// 2. POST ENERGY (the "mirror the room" signal). A reply should MATCH the energy of
//    the post it answers: answer a celebration with warmth, a joke with a joke, a
//    hot take with a sharp take, a vent with commiseration, a question with a
//    straight answer, and an analytical post with a substantive peer take. Answering
//    a joke with philosophy is the single most obvious bot tell. detectPostEnergy()
//    reads the classifier's persisted energy label first, then the classifier
//    label, then cheap text heuristics — and pickRegisterForEnergy() biases the
//    register toward that energy so HYPE never lands on a serious post and a joke
//    post draws DEADPAN/PUNCHY, never a cold analytical NORMAL.
//
// This module is the single source of truth: apps/{x,reddit}-intern/src/lib/register.ts
// are thin re-export shims over it. (LinkedIn/Lyra still keeps its own copy — a
// follow-up migrates it here too.) Pure + unit-tested; every picker takes an
// injectable rng so choices are deterministic in tests.

import type { PostRegister } from "./styleTypes.js";

export type { PostRegister };

export type RegisterId =
  | "ULTRA_SHORT"
  | "HYPE"
  | "SLANG"
  | "PUNCHY"
  | "DEADPAN"
  | "NORMAL";

export interface Register {
  id: RegisterId;
  /** Weight in (0,1]; within a subset the weights are renormalized at pick time. */
  weight: number;
  /** The "ASSIGNED REGISTER" directive injected into the reply-drafting prompt. */
  directive: string;
}

// The directive text for each register — the single source of truth for the
// wording the prompt looks for. Platform-neutral ("your reply", not "three angles"
// / "the comment") so both interns share it.
export const REGISTER_DIRECTIVES: Record<RegisterId, string> = {
  ULTRA_SHORT:
    "Reply in 3-7 words, one punchy reaction, no setup. e.g. 'this is huge', 'okay this slaps', 'the dream tbh', 'absolute cinema'. Keep it this short.",
  HYPE: "React with real excitement, CAPS + exclamations welcome ('YESSS', 'LETS GOOO', 'CONGRATS man!!', 'absolute GOAT', 'huge W'), slang welcome, keep it short. IF the post is NOT actually a win/launch/milestone/celebration, ignore this register and react normally.",
  SLANG:
    "Loose, lowercase, like texting a friend. slang ok (tbh, ngl, lowkey, fr, that's wild, no shot). Keep it to a line or two.",
  PUNCHY: "One sharp sentence with a real opinion. No hedging, no preamble.",
  DEADPAN:
    "Dry, deadpan, funny. Understated — let the joke land, never explain it. If the post is a joke, satire, or a shitpost, answer in kind: a sharper or funnier one-liner beats any analysis. No hedging, no setup.",
  NORMAL:
    "A smart, specific peer reply, the default register. A real take, proportionate to the post. Vary your opening and word choice — do not reach for the same stock phrasings every time.",
};

/** Build a Register from an id + weight, pulling the shared directive text. */
function reg(id: RegisterId, weight: number): Register {
  return { id, weight, directive: REGISTER_DIRECTIVES[id] };
}

// The full weighted register set used by the BLIND picker (pickRegister). Weights
// are tuned so NORMAL does not dominate — variety must be visible across the feed.
// (Energy-aware picking, below, ignores these and uses per-energy subsets instead.)
//   ULTRA_SHORT .22 + HYPE .10 + SLANG .22 + PUNCHY .16 + DEADPAN .10 + NORMAL .20 = 1.00
export const REGISTERS: Register[] = [
  reg("ULTRA_SHORT", 0.22),
  reg("HYPE", 0.1),
  reg("SLANG", 0.22),
  reg("PUNCHY", 0.16),
  reg("DEADPAN", 0.1),
  reg("NORMAL", 0.2),
];

/** A pathological r (>= sum, or NaN) falls back to the last register in `set`. */
function weightedPick(set: Register[], rng: () => number): Register {
  const total = set.reduce((acc, r) => acc + r.weight, 0);
  const r = rng() * (total > 0 ? total : 1);
  let cumulative = 0;
  for (const register of set) {
    cumulative += register.weight;
    if (r < cumulative) return register;
  }
  return set[set.length - 1]!;
}

/**
 * Pick ONE register blind to the post by weighted random choice. `rng` is
 * injectable so the choice is deterministic in tests; production passes
 * Math.random. Kept for callers that have no post-energy signal.
 */
export function pickRegister(rng: () => number = Math.random): Register {
  return weightedPick(REGISTERS, rng);
}

/**
 * Render the "ASSIGNED REGISTER" block injected into the reply-drafting prompt.
 * Kept next to the registers so the worker and tests share one source of truth for
 * the wording the prompt looks for. `scope` names what the register applies to on
 * this platform (e.g. "all reply angles" for X, "the comment" for Reddit) so the
 * block reads naturally in each drafter.
 */
export function renderRegisterBlock(
  register: Register,
  scope = "the reply",
): string {
  return [
    `ASSIGNED REGISTER FOR THIS REPLY (applies to ${scope}, NOT any DM)`,
    register.directive,
    "This register overrides the default length/energy for the reply only, so follow it, including ALL-CAPS, exclamations, very short fragments, and slang where it calls for them. Keep every other rule (no em dashes, no corporate verbs, no reframe/negative-parallelism, no echoing the post, English only, the emoji allowlist) fully intact. This never applies to a DM.",
  ].join("\n");
}

// ---- Post energy -----------------------------------------------------------
// A finer-grained signal than celebration/neutral: what KIND of post is this, so
// the reply can mirror its energy. Ordered from "clearly a win" to "the default
// substantive post". detectPostEnergy trusts, in order: a persisted energy label
// (produced once by the classifier and carried on the lead), the classifier label
// ('light' == a win), then cheap text heuristics. Everything falls open to
// 'analytical' (today's default behavior).

export type PostEnergy =
  | "celebration" // a win / launch / milestone / happy announcement
  | "joke" // a joke, satire, shitpost, meme, sarcasm — answer in kind
  | "hot_take" // a spicy opinion / contrarian bait — answer with a sharp take
  | "vent" // a rant / frustration / commiseration — do NOT be chirpy
  | "question" // asking for help / advice / opinions — answer straight
  | "analytical"; // the default: a substantive, informative, or opinion post

const POST_ENERGIES: readonly PostEnergy[] = [
  "celebration",
  "joke",
  "hot_take",
  "vent",
  "question",
  "analytical",
];

export function isPostEnergy(v: unknown): v is PostEnergy {
  return typeof v === "string" && (POST_ENERGIES as readonly string[]).includes(v);
}

// Strong, unambiguous celebration signals (announcement verbs + congrats + clearly
// happy framings). Deliberately narrow so an analytical post that merely mentions a
// launch isn't misread as a celebration.
const CELEBRATION_SIGNALS =
  /\b(congrats|congratulations|thrilled to|excited to (share|announce)|happy to (share|announce)|proud to (share|announce)|stoked to|pumped to|we (just )?(launched|shipped|raised|closed|hit)|i (just )?(launched|shipped|joined|raised|started|got)|just (launched|shipped|went live)|officially live|big news|day one|landed (a|my|the) (job|role|offer|gig))\b/i;

const CELEBRATION_EMOJI = /[🎉🥳🙌👏🎊🍾]/u;

// Humor / satire / shitpost markers. Deliberately EXCLUDES the ambiguous
// sad-or-laughing signals (bare 😭, "i'm dead/crying/screaming") — those show up in
// grief/vent posts just as often as jokes, and mislabeling grief as a joke is the
// worst misfire this feature can make. The skull + rolling-laugh emoji and "/s"
// (Reddit's sarcasm marker) stay because they're unambiguously comedic. 'lol'/😂
// remain but are only reached AFTER the vent/question/hot_take checks below.
const JOKE_SIGNALS =
  /\b(lol|lmao|lmfao|rofl|ha(ha)+|jaja+|jk|shit\s?post|satire|parody|the audacity|goofy|ratio(ed|'d)?)\b|\/s\b|[💀🤣]|😂/iu;

// Contrarian / opinion-bait framings.
const HOT_TAKE_SIGNALS =
  /\b(unpopular opinion|hot take|controversial( opinion| take)?|hear me out|no one wants to (say|admit)|let'?s be honest|is (overrated|underrated|dead|a scam|a meme|a joke)|nobody (talks about|admits)|say it louder|change my mind|fight me)\b/i;

// Frustration / rant / distress / loss markers. Includes job-loss + "idk what to
// do" because those grief posts often carry a nervous "lol" or 😭 and must resolve
// to vent (commiserate), never joke.
const VENT_SIGNALS =
  /\b(i'?m so (tired|sick|done|fed up)|sick of|tired of|fed up|hate (it )?when|worst part|\/?rant\b|driving me (crazy|insane|nuts)|can'?t stand|so frustrat|burn(ed|t) out|exhausted|why does .{0,30}\balways\b|laid off|got (fired|let go|rejected|dumped)|lost my (job|role|offer|gig|startup|clients?)|falling apart|(idk|don'?t know) what to do)/i;

function looksCelebratory(text: string): boolean {
  if (!text) return false;
  if (CELEBRATION_SIGNALS.test(text)) return true;
  const exclaims = (text.match(/!/g) ?? []).length;
  return CELEBRATION_EMOJI.test(text) && exclaims >= 1;
}

function looksLikeQuestion(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  if (
    /\b(how (do|did|can|should|would) (i|you|we)|what'?s the best|any (recommendations|advice|tips|suggestions)|anyone (else|know|have|tried)|am i the only|is it (just|normal)|should i|thoughts\?|need help|help me|does anyone|how would you)\b/i.test(
      s,
    )
  )
    return true;
  // A short post that is mostly a question (ends with '?') and is not a rhetorical
  // hot-take dressed as a question.
  return (
    s.endsWith("?") &&
    s.length <= 200 &&
    !/\b(unpopular|hot take|change my mind|fight me)\b/i.test(s)
  );
}

export interface DetectEnergyOpts {
  /** The lead's classifier_label ('light' == a win/celebration). */
  classifierLabel?: string | null;
  /** A persisted energy label produced by the classifier — trusted first when valid. */
  energyLabel?: string | null;
}

/**
 * Decide the post's ENERGY. Trust order:
 *   1. an explicit persisted energy label (the classifier already judged it),
 *   2. classifier_label === 'light' → celebration (matches detectPostRegister),
 *   3. text heuristics: joke → hot_take → vent → question (first match wins),
 *   4. any other non-empty classifier label → analytical (substantive),
 *   5. no label at all → looksCelebratory ? celebration : analytical.
 * Everything falls open to 'analytical', which is today's default drafter behavior.
 */
export function detectPostEnergy(
  postText: string,
  opts: DetectEnergyOpts = {},
): PostEnergy {
  const { classifierLabel, energyLabel } = opts;
  if (isPostEnergy(energyLabel)) return energyLabel;
  if (classifierLabel === "light") return "celebration";

  const t = postText ?? "";
  // Order matters. Vent and question are checked BEFORE joke: "lol" and 😂 are
  // common in grief/casual posts, and answering real distress or a genuine question
  // with a forced joke is exactly the misfire this feature must avoid. So a post
  // that trips both a vent signal and a joke signal resolves to vent, not joke.
  if (VENT_SIGNALS.test(t)) return "vent";
  if (looksLikeQuestion(t)) return "question";
  if (HOT_TAKE_SIGNALS.test(t)) return "hot_take";
  if (JOKE_SIGNALS.test(t)) return "joke";

  if (classifierLabel && classifierLabel.trim().length > 0) return "analytical";
  return looksCelebratory(t) ? "celebration" : "analytical";
}

/** Collapse the rich energy to the binary PostRegister the Account Feeder consumes. */
export function energyToRegister(energy: PostEnergy): PostRegister {
  return energy === "celebration" ? "celebration" : "neutral";
}

// ---- Energy-aware register selection ---------------------------------------
// Each energy samples from a register SUBSET tuned to it. The weights need not sum
// to 1 — weightedPick renormalizes. Design rules baked in:
//   • HYPE only ever appears under celebration (CAPS + "LETS GOOO" is fake anywhere else).
//   • DEADPAN (dry humor) appears under joke/hot_take, NEVER under a genuine question
//     or vent (snark on someone asking for help / venting reads badly).
//   • question/vent avoid the giddy short forms; they lean helpful/real.
const ENERGY_REGISTERS: Record<PostEnergy, Register[]> = {
  celebration: [
    reg("HYPE", 0.5),
    reg("ULTRA_SHORT", 0.25),
    reg("SLANG", 0.15),
    reg("NORMAL", 0.1),
  ],
  joke: [
    reg("DEADPAN", 0.4),
    reg("PUNCHY", 0.25),
    reg("ULTRA_SHORT", 0.2),
    reg("SLANG", 0.15),
  ],
  hot_take: [
    reg("PUNCHY", 0.45),
    reg("ULTRA_SHORT", 0.2),
    reg("DEADPAN", 0.2),
    reg("SLANG", 0.15),
  ],
  vent: [
    reg("SLANG", 0.35),
    reg("PUNCHY", 0.25),
    reg("NORMAL", 0.25),
    reg("ULTRA_SHORT", 0.15),
  ],
  question: [reg("NORMAL", 0.45), reg("PUNCHY", 0.35), reg("ULTRA_SHORT", 0.2)],
  analytical: [
    reg("NORMAL", 0.3),
    reg("SLANG", 0.24),
    reg("ULTRA_SHORT", 0.24),
    reg("PUNCHY", 0.22),
  ],
};

/** The register subset to sample from for a given post energy. */
export function registersForEnergy(energy: PostEnergy): Register[] {
  return ENERGY_REGISTERS[energy] ?? ENERGY_REGISTERS.analytical;
}

/**
 * Pick ONE register conditioned on the post's energy. Same weighted walk as
 * pickRegister but over registersForEnergy(energy). rng is injectable for tests.
 */
export function pickRegisterForEnergy(
  energy: PostEnergy,
  rng: () => number = Math.random,
): Register {
  return weightedPick(registersForEnergy(energy), rng);
}

/**
 * A one-line, post-specific "mirror the energy" hint for the reply prompt, shared by
 * the X and Reddit drafters. Stronger than a general "match the energy" instruction
 * because it names THIS post's detected energy. Returns "" for 'analytical' so an
 * ordinary substantive post stays byte-identical. The wording is platform-neutral.
 */
export function renderEnergyHint(energy: PostEnergy): string {
  switch (energy) {
    case "joke":
      return "POST ENERGY: this reads as a joke / satire / shitpost. MIRROR it — answer in kind with something funnier or sharper. A dry one-liner or a good riff beats any analysis; do NOT explain the joke or reply with earnest philosophy.";
    case "hot_take":
      return "POST ENERGY: this is a hot take / spicy opinion. Match it with a sharp take of your own — agree hard, push back, or one-up it. No fence-sitting, no both-sides hedging.";
    case "vent":
      return "POST ENERGY: this is a vent / frustration. Commiserate like a peer who gets it. Do NOT be chirpy, do NOT lecture or try to fix it, and do NOT pitch anything.";
    case "celebration":
      return "POST ENERGY: this is a win / celebration. Be genuinely warm and hyped for them, short and real — never a corporate 'congratulations on this milestone'.";
    case "question":
      return "POST ENERGY: they asked a real question. Actually answer it, concretely and directly. No preamble, no 'great question'.";
    case "analytical":
    default:
      return "";
  }
}

// ---- Backward-compatible celebration/neutral API ---------------------------
// Preserved so existing callers/tests keep working while the finer energy API is
// adopted. detectPostRegister is now defined in terms of detectPostEnergy.

/**
 * Decide the post's register (celebration vs neutral). Backward-compatible wrapper
 * over detectPostEnergy — 'light' → celebration, any other non-empty label →
 * neutral, no label → text heuristic.
 */
export function detectPostRegister(
  postText: string,
  classifierLabel?: string | null,
): PostRegister {
  return energyToRegister(detectPostEnergy(postText, { classifierLabel: classifierLabel ?? null }));
}

/** The register subset for a celebration/neutral post register (compat). */
export function registersForPost(postRegister: PostRegister): Register[] {
  if (postRegister === "celebration") return ENERGY_REGISTERS.celebration;
  // neutral → everything EXCEPT HYPE (no manufactured excitement on a serious post).
  return REGISTERS.filter((r) => r.id !== "HYPE");
}

/** Pick ONE register conditioned on a celebration/neutral post register (compat). */
export function pickRegisterForPost(
  postRegister: PostRegister,
  rng: () => number = Math.random,
): Register {
  return weightedPick(registersForPost(postRegister), rng);
}

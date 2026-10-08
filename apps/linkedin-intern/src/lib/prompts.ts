import { ANTI_AI_RULES, WRITING_STRUCTURE_GUIDANCE } from "@noelle/runtime";
import { renderVoiceExemplars } from "@noelle/runtime/voice-exemplars";
import type { VoiceExemplar } from "@noelle/runtime/prior-replies";
import { NO_COMMITMENTS_RULE } from "@noelle/runtime/commitment-guard";
import { NO_HOUSE_SKELETON_RULE, NO_PERIODS_RULE } from "@noelle/runtime";

// SYSTEM prompts for the LinkedIn drafter ("Lyra") + profiler. Mirrors
// apps/x-intern/src/lib/prompts.ts but specialised for LinkedIn:
//   - the public variant is a COMMENT on someone's post (not an X reply),
//   - the audience comes from the configured growth objective and watchlist,
//   - the per-person profile (summary/topics/tone/engagement_notes) is woven in
//     by the drafter prompt so each comment is tailored.
// The three-angle shape (empathetic / technical / contrarian) + one DM is
// identical to the X intern so the dashboard/contract are unchanged. The drafter
// trims the angle set per tier (T1→3, T2→2, T3→1) + DM only for T1, and uses the
// SYSTEM_LINKEDIN_LIGHT variant for 'light' (short supportive) leads.
//
// Like x-intern, the quality classifier + retrieval-score gate run upstream; by
// the time the model sees this prompt the lead is already judged worth a reply,
// so the model should not output a skip.

import type { BrandConfig } from "@noelle/contracts";
import { brandConfigHasContent } from "@noelle/contracts";
import type { PostRegister } from "./register.js";
import type { DmRung } from "./dm-ladder.js";
// renderStyleBlock + the StyleForPrompt shapes now live in @noelle/runtime (shared
// with Vega). Imported for this file's own use + re-exported so drafter-tick keeps
// importing them from here.
import { renderStyleBlock } from "@noelle/runtime";
import type { StyleForPrompt } from "@noelle/runtime";
export { renderStyleBlock };
export type { StyleForPrompt, StyleExemplarForPrompt } from "@noelle/runtime";

// Shared drafting rules woven into every prompt variant so the voice discipline
// lives in one place (deliberately mirrored in apps/x-intern/src/lib/prompts.ts).
// The emoji allowlist itself is the canonical Set in @noelle/runtime (stripDisallowedEmoji).

const EMOJI_RULE = `EMOJI / STICKERS
Default to NONE. You may use an emoji ONLY when the original post itself uses emoji (match their register), and ONLY from this exact set: 💀 😭 😛. At most one, never as a bullet or as decoration. Every other emoji is banned — no 🚀 🔥 👏 🎉 ✅ 💡 🙌, none of them. If the post has no emoji, use none.`;

const PICK_ONE_THREAD = `PICK ONE THREAD (do not answer the whole post)
A post usually carries several threads — a metric, a confession, a lesson, an aside. Trying to touch all of them is the #1 bot tell: it reads like a summary and runs long. Pick the ONE thread you actually have something real to say about and develop just that. One true, specific thing beats covering everything. A short, warm personal closer that reacts to a single human detail they dropped is welcome when it lands (e.g. "hope Lisbon was worth it"), as long as it stays a quick aside and not a second paragraph.`;

const GENZ_MARKER_RULE = `SPOKEN REGISTER (when present)
A block labelled "SPOKEN REGISTER FOR THIS REPLY" may appear below the post. It offers ONE current spoken marker you MAY use, once, and it OVERRIDES the general ban on casual abbreviation textures in a public comment for that ONE marker only. Everything else about that ban stands.
It is a permission, not an order: drop it entirely when the comment has no natural place for it, never use two markers in one comment, and never let the marker become the point. It does NOT unban slang cosplay (fr fr, no cap, rizz, based, it's giving, slay, bussin, ate) and it does not relax any other NEVER DO rule. It never applies to the DM.`;

/**
 * Brand-agnostic LinkedIn drafter base. Same voice discipline, three-angle
 * shape, DM shape, and strict JSON output as SYSTEM_LINKEDIN_BASE — but with NO
 * baked-in persona or product. Used when the operator has supplied a
 * brand_config; the persona/product/pitch/Q&A/style come from renderBrandBlock()
 * prepended above this. When brand_config is empty we fall back to SYSTEM_LINKEDIN_BASE.
 */
export const SYSTEM_LINKEDIN_BASE = `You are a LinkedIn growth intern drafting public comments and one cold-outreach DM on behalf of an operator. Use the supplied OPERATOR BRAND and voice context when present. Without them, do not invent identity, biography, product facts or an offer; do not pitch without a verified product brief. Write as the operator the way they actually talk — like the operator themselves, not a marketing team. You are engaging the configured LinkedIn audience as a curious peer: engage from genuine interest, ask the question you actually have, build on their point — never as an expert grading their post or handing down verdicts. (Curious is NOT self-diminishing — never fake-convert or shrink yourself to flatter them. Genuinely interested AND keeping your own real opinion, both at once.)

${WRITING_STRUCTURE_GUIDANCE}

The gating step (is this post worth commenting on?) has already happened upstream. Do NOT second-guess it. Draft three good comments. Do not output a SKIP. If you genuinely cannot say anything useful, write the most honest peer comment you can.

${PICK_ONE_THREAD}

THE THREE ANGLES (always all three, in this order)
- empathetic: react with a real operator opinion or reaction the post sparks. Do NOT echo or paraphrase their post back at them. Mention the product only if the post is literally about something it addresses (see OPERATOR BRAND → fits_when).
- technical: sharper, but curious rather than verdict-giving. Offer how YOU see the root cause and stay open about it ("my read is…", "is it X for you or more Y?") instead of pronouncing the answer from above. If the product maps to it, name the relevant capability. If it does not map, just be a sharp peer.
- contrarian: a curious counter-question or a respectful disagreement. Surface a real diagnostic split. If it clearly maps to the product, make the connection. Otherwise stay a peer.

VOICE (the thing everyone gets wrong)
Direct. Specific. Human. Ragged when the topic calls for it. Run-on sentences allowed. Parenthetical asides mid-thought. Lowercase mid-sentence is fine. Concrete numbers and tool names land harder than adjectives. Honest uncertainty beats fake confidence — lean into real curiosity ("how'd you handle X?") instead of narrating from a pedestal. Write like the operator actually talks, just a touch warmer than an X reply — never a "professional network" register: if it reads like a brand's social team or a LinkedIn thought-leader wrote it, it's wrong. Never corporate. Comments are English-only. Follow any extra voice notes in OPERATOR BRAND → reply style.
Avoid the choppy "fragment. fragment." period style — short declarative sentences stacked with full stops is a top AI tell. Glue clauses with commas + connectors/fillers (and, but, so) so it reads like one person talking, and lean first-person where it's natural.

MATCH THE ENERGY (read the room first)
Read the register of the post before writing. Answering a light, funny, or celebratory post with a serious analytical take is the most obvious "bot in the comments" tell there is. If the post is a joke, a one-liner, a quick win, or an unserious riff, keep the comment short, light, and in on it — do NOT force depth, a lesson, or a root-cause analysis onto it. If the post is serious, technical, or a real question, bring substance. When in doubt, sound like a real person reacting in the moment, not an analyst filing a report; the comment should feel proportionate to the post.

ASSIGNED REGISTER (when present)
A block labelled "ASSIGNED REGISTER FOR THIS REPLY" may appear below the post. When it does, it OVERRIDES the default length and energy of the comments — follow it exactly, including ALL-CAPS, exclamations, very short fragments (even a 3-7 word one-liner), and slang/jerga when the register calls for them. The register can override the tight-comment length default. It does NOT relax any NEVER DO rule below (no em dashes, no corporate verbs, no reframe/negative-parallelism, no echoing the post, English only, the emoji allowlist) and it never applies to the DM.

${GENZ_MARKER_RULE}

${EMOJI_RULE}

${NO_COMMITMENTS_RULE}

${ANTI_AI_RULES}

${NO_HOUSE_SKELETON_RULE}

${NO_PERIODS_RULE}

NEVER DO
- Invent personal history (HARD BAN, the #1 AI tell). Do NOT fake your own backstory — no "I started cold-emailing my first summer", "back when I was 14", "after a cofounder burned me", "I've shipped X of these". Vague anonymous anecdotes are just as fake: never "one guy did X", "a founder I know", "someone I talked to" as filler. A referenced story must be TRUE and concretely attributed (a friend, my cofounder, a specific person), otherwise react with a real opinion or a specific observation instead. If you don't have a TRUE story, don't manufacture one.
- Manufacture agreement or a fake-conversion arc (HARD BAN). Never write "I used to do X, then realized I was wrong and started doing it your way", and never diminish yourself just to validate the post. Do not claim the operator adopted an approach or changed their mind without evidence. Agree ONLY when it's genuinely true and specific; otherwise bring your own real take, add a concrete angle, or push back. Flattery-by-self-deprecation is the exact tell to avoid.
- Em dashes (—, –, ―, --). Use commas, parentheses, or periods.
- Reframe / negative parallelism (HARD BAN). Never reject one frame to assert another: no "not X, it's Y", "isn't just X, it's Y", "most people do X, you do Y", "X gets attention, Y matters more", "that's a different game/problem", "the real X is Y", or a rhetorical-question pivot. State the positive claim directly and delete the rejected half.
- Choppy AI cadence (short. clipped. fragments.). Glue clauses with commas and connectors (and, but, so, because) so it reads like one person talking, and lean first-person.
- Any emoji outside 💀 😭 😛, and even those only when the post itself uses emoji.
- Portable generic praise and hollow LinkedIn engagement-bait ("This. 👏", "Couldn't agree more", "Great post!", "Thanks for sharing") stay banned. A short spoken acknowledgement is allowed only when the same thought gives a post-specific reason or referent. If it could sit under another post unchanged, cut it.
- Corporate verbs: unlock, empower, leverage, streamline, delight, supercharge, revolutionize, seamless, synergy, cutting-edge, next-generation.
- "to be honest" / "honestly" as a reflexive hedge-opener (starting a comment with it, or leaning on it every line). A single natural "honestly" or "tbh" as texture is fine — but never as a throat-clearing opener or a verbal tic; when it's just hedging, cut it and say the thing directly.
- Inspirational fog, comment-bait dressed up as wisdom, hashtag spam.
- Echoing the post back at them — "the part where you said…", "your point about…", or quoting their words. This is the #1 AI tell.
- Vague referential filler / lazy reactions (operator ban): pointing back at the post instead of naming the thing — "the part where/of…", "the stuff" / "or the stuff", "something of the post/their take" — and the "this slaps" / "slaps" reaction tic. Say the specific thing you actually mean.
- Insight-bait TEMPLATES (HARD BAN): "the gap between X and Y is where most…", "X is where most orgs quietly stall/struggle", "the real difference is…", "what separates X from Y is…". Fill-in-the-blank AI filler. Say one concrete, specific thing about THEIR situation instead.
- Reaction clichés: "hits different", "this hits", "hits home/hard", "this lands", "lands well". Just say what you actually think in plain words.
- Filler closers / fake-curiosity endings: "curious to hear how it lands", "would love to hear how this plays out", "keen to see how it unfolds". End on your actual point, not a hollow open-ended question.
- The word "babysit" (and "hand-holding" as a buzzword). Say it plainly instead ("you still end up shepherding it", "it still needs steering").
- Bolting the product onto unrelated posts. If it doesn't map, write a peer comment. Never force a startup/founder analogy onto an off-topic post (sports, etc.) — if it isn't relevant, it isn't a comment.
- Plus any operator-specified NEVER-DO rules in OPERATOR BRAND.

THE DM (one per lead, alongside the three comments)
After the comments, write ONE direct message: the private outreach the operator would send this person on LinkedIn. The DM is NOT a comment. It is longer, warmer, ragged, and where the actual pitch lives (subject to the brand's pitch policy).

DM shape (defaults — OPERATOR BRAND → dm style overrides any of these):
- Open with a casual greeting on its own line (a first name when given).
- Next, get to it like a human. Do NOT open by quoting or echoing their post.
- Then the pitch, honoring the brand's pitch policy and fit rules. When pitching, put the product URL on its own line and the install/CTA line on its own line. If the product does not map (and policy isn't "always"), drop the pitch. Never invent fit.
- Close with a soft sign-off on its own line.
- Fragmented: 4 to 6 short chunks separated by blank lines (use literal \\n between chunks inside the JSON string).
- Length: aim 400 to 700 characters, hard max 900.
- The NEVER-DO list applies, BUT a greeting is welcome here.

OUTPUT FORMAT — STRICT JSON, NO MARKDOWN FENCES, NO PREAMBLE
The very first character of your response MUST be \`{\` and the last \`}\`. Output exactly:

  {"drafts":[{"angle":"empathetic","body":"…","char_count":N},{"angle":"technical","body":"…","char_count":N},{"angle":"contrarian","body":"…","char_count":N}],"dm":{"body":"…","char_count":N}}

Each comment \`body\` is SHORT and MATCHES THE POST'S ENERGY. There is NO minimum length — usually ONE sentence, often just a 5-15 word reaction. A light or fun post gets a light, short reply; do NOT manufacture a lesson, an "insight", or a personal anecdote the post didn't ask for. Only go deeper when you genuinely have one specific, concrete point — and even then, keep it to a single sentence. Hard cap ~150 chars, but most comments should land well under 100 — UNLESS a STYLE block below assigns THIS REPLY'S ASSIGNED SHAPE; then the assigned shape's length and sentence count override this cap for the comments. Shorter-and-specific always beats longer-and-insightful. \`char_count\` must equal the actual length. Output exactly three comment drafts (one per angle, in order) PLUS exactly one \`dm\`; the \`dm.body\` char_count must equal its actual length. Do NOT output a "skip" — the upstream gate already filtered.`;

/** Browser-discovered posts get one public peer reply, with no sales context. */
const SYSTEM_LINKEDIN_BROWSER_REPLY = `Write exactly ONE public LinkedIn comment in the operator's voice. The post below is the subject; choose one specific point you can genuinely add to as a peer. A question is useful only when you actually have one.

${WRITING_STRUCTURE_GUIDANCE}

${PICK_ONE_THREAD}

Match the post's energy. A small win can take a short warm reaction; a technical question can take a concrete answer. State only facts supported by the post or supplied context. Never invent the operator's experience, a product capability, a result, or an outcome.

Do not pitch or mention the operator's company, product, website, agents, approval workflow, or internal process. Do not turn an unrelated post into a story about the operator. The browser lane has no verified product brief; answer the author from the post itself.

Voice: direct, specific, human, a little ragged when natural. Write as the operator in first person when it fits. Do not echo the post, flatter generically, grade the author, or sound like a brand account. English only.

${EMOJI_RULE}

${NO_COMMITMENTS_RULE}

${ANTI_AI_RULES}

${NO_HOUSE_SKELETON_RULE}

${NO_PERIODS_RULE}

Output strict JSON with exactly one comment in drafts, with its chosen angle, body, and char_count. No DM and no skip.`;

const BROWSER_REPLY_GROUNDING = "Choose one concrete detail from the original post, then add a small observation that detail actually supports. A genuine unanswered question works when it asks about a distinction or decision the author left open; avoid asking for metrics or methods not in the post. Do not summarize the post or repeat its numeric hook as your opening; retelling the author's anecdote is not a contribution. Keep if, may, could, and other hypothetical claims conditional as in the source. An anecdote in the post is not proof of causation: never join a separate example to a projection as if it proved the projected result. Pinned writer or style examples teach tone and form only; never import their personal experience, process, or product claims. If the post gives no basis for a personal claim, use a short reaction or honest question instead of inventing one. Use a capital letter at the start instead of defaulting to an all-lowercase opening. Keep the operator's natural rhythm and the NO FULL STOPS rule.";

const BROWSER_REPLY_OPERATOR_VOICE = "The operator's actually sent replies define the voice, word choice, and register for this browser reply. Pinned writer posts offer form ideas only; never imitate their diction or force their casing, joke, or aside over the operator's examples. For an analytical post, use the POST → REPLY pairs to find a concrete constraint or unresolved implication in the source, then say what follows in plain words. Do not restate the post as an architecture summary or invent an untested result. For a celebration, make one specific warm reaction instead of forcing an analysis. Keep the assigned shape when one is present.";

function browserReplyShape(style: StyleForPrompt | null | undefined, faithful: boolean | undefined): string {
  // The browser lane borrows the pinned writer's form without inheriting that
  // writer's voice. The normal faithful block used to carry the shape itself.
  return faithful && style?.formVariant
    ? `THIS REPLY'S ASSIGNED SHAPE (public comment only): ${style.formVariant.directive}`
    : "";
}

/** Name and voice are useful; product facts and bio are not evidence for a cold reply. */
function renderBrowserReplyBrand(brand?: BrandConfig | null): string {
  const lines = ["OPERATOR VOICE (style only, not reply subject)"];
  if (brand?.persona?.name) lines.push(`Write as ${brand.persona.name} in first person.`);
  if (brand?.reply_style?.voice_notes) lines.push(`Voice notes: ${brand.reply_style.voice_notes}`);
  if (brand?.reply_style?.never_do?.length) {
    lines.push("Additional NEVER-DO:");
    for (const rule of brand.reply_style.never_do) lines.push(`- ${rule}`);
  }
  return lines.join("\n");
}

/**
 * Render the OPERATOR BRAND section from an operator-set brand_config. Mirrors
 * the X intern's renderBrandBlock — the brand config shape is platform-agnostic.
 */
export function renderBrandBlock(brand: BrandConfig): string {
  const lines: string[] = ["OPERATOR BRAND (set by the operator — this defines who you are and what you may pitch)"];

  if (brand.persona?.name)
    lines.push(
      `You ARE ${brand.persona.name}. Write in the FIRST PERSON as ${brand.persona.name} ("I", "me", "my") — never refer to ${brand.persona.name} in the third person or narrate them by name as if they were someone else.`,
    );
  if (brand.persona?.bio) lines.push(`About you: ${brand.persona.bio}`);

  const p = brand.product;
  if (p?.name || p?.description) {
    lines.push("", "PRODUCT / OFFER");
    if (p.name) lines.push(`Name: ${p.name}`);
    if (p.description) lines.push(`What it is: ${p.description}`);
    if (p.url) lines.push(`URL (put on its own line when pitching): ${p.url}`);
    if (p.install) lines.push(`Install / CTA line (own line when pitching): ${p.install}`);
    if (p.surfaces?.length) lines.push(`Public surfaces you may reference: ${p.surfaces.join(", ")}`);
    if (p.fits_when?.length) {
      lines.push(`The product genuinely FITS only when the post is about: ${p.fits_when.join("; ")}. If the post isn't about one of these, do NOT pitch it.`);
    }
  }

  const policyLine =
    brand.pitch_policy === "never"
      ? "PITCH POLICY: never pitch the product. Always stay a genuine peer, even in the DM."
      : brand.pitch_policy === "always"
        ? "PITCH POLICY: you may pitch in the DM on every lead, but only where it's honest — never fabricate fit."
        : "PITCH POLICY: pitch ONLY when the product genuinely fits the post (see fits_when). When it doesn't, write a peer comment with no pitch.";
  lines.push("", policyLine);

  if (brand.qa?.length) {
    lines.push("", "BRAND Q&A (ground your comments + DM in these answers; use them, do not quote them verbatim)");
    for (const item of brand.qa) lines.push(`Q: ${item.q}\nA: ${item.a}`);
  }

  if (brand.reply_style?.voice_notes || brand.reply_style?.never_do?.length) {
    lines.push("", "REPLY STYLE");
    if (brand.reply_style.voice_notes) lines.push(brand.reply_style.voice_notes);
    if (brand.reply_style.never_do?.length) {
      lines.push(`Additional NEVER-DO: ${brand.reply_style.never_do.join("; ")}.`);
    }
  }

  const dm = brand.dm_style;
  if (dm && (dm.greeting || dm.closing || dm.notes || dm.fragments_min || dm.len_min)) {
    lines.push("", "DM STYLE (overrides the default DM shape)");
    if (dm.greeting) lines.push(`Open with: "${dm.greeting}" (plus a first name when given).`);
    if (dm.closing) lines.push(`Close with: "${dm.closing}"`);
    if (dm.fragments_min || dm.fragments_max) {
      lines.push(`Fragments: ${dm.fragments_min ?? 4} to ${dm.fragments_max ?? 6} short chunks separated by blank lines.`);
    }
    if (dm.len_min || dm.len_max) lines.push(`Length: aim ${dm.len_min ?? 400} to ${dm.len_max ?? 700} characters.`);
    if (dm.notes) lines.push(dm.notes);
  }

  return lines.join("\n");
}


// ---- Pattern Breaker rules -------------------------------------------------
// The Pattern Breaker (packages/runtime/src/patternBreaker) discovers structural
// habits the operator over-uses across their last N posts and stores them as
// noelle.pattern_rules. The drafter injects the active rules' instructions here
// so the writer actively BREAKS them — the proactive complement to the verifier
// catching them after the fact.

/** A learned anti-pattern rule as the drafter consumes it. */
export interface PatternRuleForPrompt {
  instruction: string;
  source?: "auto" | "refined" | "manual";
  /** The positive "do this instead" mirror; appended to the ban when present. */
  suggestion?: string | null;
}

/** One rule as its NEVER-DO line plus, when present, its positive mirror
 * ("- <ban> → instead: <suggestion>") — steer the drafter, don't just fence it. */
function renderPatternRule(r: PatternRuleForPrompt): string {
  const instruction = r.instruction.trim();
  const suggestion = r.suggestion?.trim();
  return suggestion ? `- ${instruction} → instead: ${suggestion}` : `- ${instruction}`;
}

export function renderPatternRulesBlock(rules: PatternRuleForPrompt[]): string {
  // The public reply rule bans full stops. Do not let an automatically learned
  // terminal-punctuation habit contradict it in the writer's final instructions.
  const active = rules.filter((r) => r.instruction.trim() &&
    !(r.source === "auto" && /\bwithout terminal punctuation\b/i.test(r.instruction)));
  if (active.length === 0) return "";
  return [
    "BREAK THESE REPEATED PATTERNS (learned from your own recent posts — you lean on these too hard, so deliberately do something different here)",
    ...active.map(renderPatternRule),
    "These are habits, not hard bans on a topic: vary the opener, the rhythm, and the closer so this post does not read like a template of the last ten. Keep every voice and NEVER-DO rule above intact.",
  ].join("\n");
}

// ---- F6b: Batched light-lead prompt ----------------------------------------
// The batched path groups N light leads into ONE model call, each carrying its
// own post text + its own per-lead STYLE block (selectStyleExemplars is called
// per lead — not one shared context). The model returns a strict JSON array
// [{id, reply}], one entry per input id, same order. On any parse failure the
// caller falls back to per-lead single calls (fail-open, spec §9).

/**
 * One lead's data for a batched-light call. The id is a unique, tick-local
 * handle (UUID or index) used to correlate the model's array entries back to
 * the original lead — the model is instructed to echo it verbatim.
 */
export interface BatchedLightLeadInput {
  id: string;
  postText: string;
  authorName: string | null;
  publicId: string | null;
  /** Per-lead STYLE block (from selectStyleExemplars), or "" when style is off. */
  styleBlock: string;
  /** Voice anchors from the operator's KB for this lead's post. */
  anchors: string[];
  /** Product-knowledge snippets, or [] when off. */
  knowledgeAnchors: string[];
  /** Image caption line, or "" when none. */
  imageCaption: string;
  /** Existing comment digest, or "" when none. */
  commentDigest: string;
  /** Register block (variety), or "" when off. */
  registerBlock?: string;
  /**
   * The standalone "THIS REPLY'S ASSIGNED SHAPE" block for this lead, when the
   * shape could not be rendered inside its style block (no pinned voice).
   * Mutually exclusive with registerBlock — both claim reply length.
   */
  shapeBlock?: string;
  /** Opening-move block (variety), or "" when off. */
  openingMoveBlock?: string;
  /**
   * The gen-z "SPOKEN REGISTER" marker block, or undefined when this lead was
   * offered no marker. NOT mutually exclusive with the register or the shape:
   * it governs word choice, not length, so it is pushed on its own.
   */
  genzBlock?: string;
  /** Prior replies to this author (do-not-repeat memory). */
  priorReplies?: string[];
  /** Recent phrasings across the feed (global avoid-list). */
  recentPhrasings?: string[];
}

/**
 * Render the batched system prompt used when grouping N light leads into one
 * model call. The system instruction replaces the single-lead LIGHT system
 * prompt with a batch-aware variant: "you are drafting one reply PER post
 * below; return a strict JSON array [{id, reply}] with one entry per input id,
 * same order." All existing light-lead voice/format/NEVER-DO rules still apply
 * — the only difference is the output shape (array, not single object) and the
 * multi-lead user content.
 *
 * This is a SYSTEM prompt for `runner.draft`; the user content is built by
 * `renderBatchedLightUserPrompt`. Kept separate so tests can assert on each.
 */
export const BATCHED_LIGHT_SYSTEM_SUFFIX = `

BATCHED MODE
You are drafting ONE short reply for EACH post enumerated below. For each post you will be given:
  - id: a unique handle (echo it back verbatim in the output)
  - post: the LinkedIn post text
  - style: (when present) STYLE TO EMULATE notes for that specific post — treat them as per-post FORM guidance
  - anchors: (when present) voice anchors from the operator's knowledge base for that specific post
  - knowledge: (when present) product-knowledge snippets for that specific post
  - image: (when present) image caption for that specific post
  - comments: (when present) COMMENT SECTION for that specific post
  - register: (when present) ASSIGNED REGISTER for that specific reply
  - shape: (when present) THIS REPLY'S ASSIGNED SHAPE for that specific reply — it REPLACES the default comment length below
  - spoken register: (when present) a SPOKEN REGISTER block offering ONE marker for that specific reply, and ONLY that one
  - opening_move: (when present) OPENING MOVE for that specific reply
  - prior_replies: (when present) prior replies to this author (do not repeat)
  - recent_phrasings: (when present) recent phrasings across the feed (avoid-list)

Apply ALL length, format, NEVER-DO, and VOICE rules from above to EVERY reply. The STYLE block, anchors, ASSIGNED REGISTER, ASSIGNED SHAPE and SPOKEN REGISTER are PER-POST — apply each only to the reply for that post. A SPOKEN REGISTER block under ONE post never licenses that marker, or any marker, in the replies to the OTHER posts; most posts in a batch carry none at all, and those replies use no marker. One short comment per post: 1-2 sentences, ~90-180 chars, hard cap ~220 — UNLESS that post carries an ASSIGNED SHAPE (as its own block or inside its style block); then that shape's length and sentence count REPLACE this default entirely, and it may legitimately be three words or a 320-char run-on. Do not drag a shaped reply back toward the default band.

OUTPUT FORMAT — STRICT JSON ARRAY, NO PREAMBLE, NO MARKDOWN FENCES:
The very first character of your response MUST be \`[\` and the last \`]\`. Output exactly one entry per input post, in the SAME ORDER as the input, each entry:
  {"id":"<echo the id verbatim>","reply":"<the short comment body>"}
No angle field, no char_count field, no extra keys. No skip entries — write the best honest peer comment even when you have little to say.`;

/**
 * Render the user content for a batched-light call: enumerate each lead as a
 * numbered block with its id, post text, optional context blocks (STYLE,
 * anchors, knowledge, image, comments, register, opening_move, prior_replies,
 * recent_phrasings). The model is expected to return a JSON array with one
 * {id, reply} per entry.
 */
export function renderBatchedLightUserPrompt(leads: BatchedLightLeadInput[]): string {
  const blocks = leads.map((l, idx) => {
    const who = l.authorName ?? (l.publicId ? `@${l.publicId}` : "a watchlist person");
    const parts: string[] = [`[${idx + 1}] id: ${l.id}`, `post by ${who}:`, l.postText];
    if (l.imageCaption) parts.push(`image: ${l.imageCaption}`);
    if (l.commentDigest) parts.push(l.commentDigest);
    if (l.anchors.length > 0) {
      parts.push(
        "anchors (voice-ground your reply — do not force-reference):",
        l.anchors.map((a, i) => `[${i + 1}] ${a}`).join("\n"),
      );
    }
    if (l.knowledgeAnchors.length > 0) {
      parts.push(
        "knowledge (ONLY facts you may assert about the product):",
        l.knowledgeAnchors.map((a, i) => `[${i + 1}] ${a}`).join("\n"),
      );
    }
    if (l.priorReplies && l.priorReplies.length > 0) {
      const pr = l.priorReplies
        .slice(0, 5)
        .map((b, i) => `[${i + 1}] ${b.length > 240 ? `${b.slice(0, 237)}…` : b}`);
      parts.push(
        "prior_replies (do NOT repeat these takes or phrasings to this person):",
        pr.join("\n"),
      );
    }
    if (l.recentPhrasings && l.recentPhrasings.length > 0) {
      const rp = l.recentPhrasings
        .slice(0, 12)
        .map((b, i) => `[${i + 1}] ${b.length > 160 ? `${b.slice(0, 157)}…` : b}`);

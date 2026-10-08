import { WRITING_STRUCTURE_GUIDANCE, X_ORIGINAL_POST_GUIDANCE } from "@noelle/runtime";
import { corpusEngagement } from "@noelle/runtime/account-feeder-db";
import { z } from "zod";
import { loadVoiceSpec, voiceSpecBlock } from "./voice-spec.js";
import type { XCommunity } from "./x-communities.js";
import { renderPostFactualContext } from "./post-drafter-context.js";

// Post-drafter — pure logic (system, prompt, parse). Side-effect-free so the
// prompt assembly + parsing is unit-testable without an LLM. The gather (DB/KB),
// the model call, the verify loop, and the sink live in post-drafter-tick.ts.
// The one I/O exception: buildPostDrafterSystem reads the operator's vault
// voice-spec (cached) so the vault is the single source of voice truth.

// A chosen style exemplar injected into the post-drafter prompt (F8). The
// drafter imitates the FORM (structure, hooks, rhythm, length) of these real
// human posts — NEVER their content or topics.
export interface PostStyleExemplar {
  body: string;
  likeCount: number | null;
  commentCount: number | null;
}

// The style selection produced by selectStyleExemplars (kind='post'). Passed
// directly into buildPostDrafterSystem / renderPostDrafterPrompt so the prompt
// builder is unit-testable without a DB or Voyage call.
export interface PostStyleSelection {
  exemplars: PostStyleExemplar[];
  /** Prose style notes (voice/tone/structure/hooks) from the matched ultra profiles. */
  styleNotes: string;
}

/**
 * Render the STYLE TO EMULATE block that is injected into the post-drafter system
 * prompt when NOELLE_POST_STYLE is on and the style pool is non-empty (F8). When
 * there is no selection (gate off / empty pool / error) this returns "" and the
 * post-drafter behaves EXACTLY as today (byte-identical output path).
 *
 * The block reinforces, not contradicts, the existing no-fabrication and
 * no-oracle rules already in buildPostDrafterSystem:
 *   - "match the FORM" (structure, hook, rhythm, length) — form only, no topics
 *   - "do NOT borrow content/topics" — explicit borrow-restriction
 *   - "obey ALL existing post rules" — keeps no-fabrication hard ban in force
 *   - "never fabricate" — second mention of the hard ban
 */
export function buildPostStyleBlock(selection: PostStyleSelection | null | undefined): string {
  if (!selection || selection.exemplars.length === 0) return "";

  const lines: string[] = [
    "",
    "## STYLE TO EMULATE",
    `Study the FORM of these ${selection.exemplars.every(ex => corpusEngagement(ex.likeCount, ex.commentCount) !== null) ? "high-performing" : "saved"} human posts — their structure, opening`,
    "move, hook shape, rhythm, sentence length, and paragraph breaks. Match that form.",
    "Do NOT borrow their content, topics, claims, or wording — only the SHAPE.",
    "Obey ALL existing post rules (no fabrication, no oracle poses, no em dashes, etc.);",
    "these examples REINFORCE those rules, not override them. NEVER invent a story or",
    "biographical detail that isn't in the supplied factual evidence; the example posts are",
    "for STRUCTURAL study only.",
    "",
  ];

  if (selection.styleNotes) {
    lines.push("### Account style notes (voice / tone / structure / hooks)");
    lines.push(selection.styleNotes);
    lines.push("");
  }

  lines.push("### Example posts (borrow the FORM, never the content)");
  selection.exemplars.forEach((ex, i) => {
    const perf = `${ex.likeCount ?? "unknown"} likes, ${ex.commentCount ?? "unknown"} comments`;
    lines.push(`[Style example ${i + 1}] (${perf})`);
    lines.push(ex.body.replace(/\s+/g, " ").trim().slice(0, 800));
    lines.push("");
  });

  return lines.join("\n");
}

export interface PostDraftContext {
  hook: string;
  thesis: string | null;
  angle: string | null;
  pillar: string | null;
  /** Voice snippets to MATCH in tone (not topics to force in). */
  voiceAnchors: string[];
  /** Supplied factual knowledge, kept separate from voice and inspiration. */
  knowledgeAnchors?: string[];
  /** Excerpts of the posts this idea was inspired by (structure, not wording). */
  inspirationExcerpts: string[];
  /** Reusable hook patterns from top-performer playbooks. */
  hookPatterns: string[];
  /** Operator standing rules pinned from the drafter chat (always applied). */
  standingRules: string[];
  /** Operator framing / anecdote from this idea's chat thread (this post only). */
  chatGuidance: string[];
}

export interface PostCta {
  product?: string;
  url?: string;
  tagline?: string;
}

export function buildPostDrafterSystem(
  platform: string,
  objective: string | null,
  brandBlock?: string | null,
  cta?: PostCta,
  styleSelection?: PostStyleSelection | null,
  community?: XCommunity | null,
): string {
  // Render the STYLE block (F8). Empty string when the gate is off / no selection
  // — the .filter(Boolean) below removes it, so the system prompt is
  // BYTE-IDENTICAL to the no-style path when the gate is off or the pool is empty.
  const styleBlock = buildPostStyleBlock(styleSelection);
  // Single source of voice truth: the operator's vault voice-spec (null when the
  // vault has none yet → prompt byte-identical to before).
  const spec = loadVoiceSpec();
  // X gets its own ruthlessly-short system; everything else stays the LinkedIn
  // path (byte-identical to before this fan-out change when no spec is present).
  // The community frames one of the 3 X variants (LinkedIn ignores it).
  if (platform === "x") return buildXPostSystem(objective, brandBlock, styleBlock, spec, community);
  const hasProduct = Boolean(cta?.product && cta.url);
  return [
    WRITING_STRUCTURE_GUIDANCE,
    "You write LinkedIn posts in a specific operator's voice. Turn the idea below",
    "into ONE finished, publish-ready LinkedIn post that makes a single clear point.",
    // The vault voice-spec, when present, leads — the inlined rules reinforce it.
    voiceSpecBlock(spec),
    // Same brand context the reply drafter writes with, so posts are on-brand.
    brandBlock ? `\n${brandBlock}\n` : "",
    objective ? `\nOperator objective: ${objective}\n` : "",
    "",
    "On LinkedIn, the first 1-2 lines show before '…see more'. Before writing the",
    "post, draft 4-5 source-supported candidate hooks, then pick the strongest true one.",
    "A good hook uses a supplied number, constraint, result, question or stake when one",
    "exists. If the source is quiet or narrow, keep the hook quiet and narrow too.",
    "Use the PROVEN HOOK PATTERNS as options, not obligations. Adapt a pattern only",
    "when it fits the supplied facts and operator guidance; never inflate the opening",
    "with unsupported stakes, conflict, personal drama or certainty.",
    "",
    "VOICE: match the operator's voice anchors in tone, rhythm and vocabulary.",
    "Study the inspiration posts for possible approaches; choose the structure this idea needs.",
    "Never copy wording. First person is for supported personal claims, not a required opener.",
    "",
    "NEVER DO (these read as AI slop and get rejected):",
    "  - FAKE THE OPERATOR'S HISTORY (hard ban, the #1 AI tell). No invented ages",
    "    ('when I was 17'), no 'I mass-applied to 40 things', 'I used to spend hours",
    "    doing X', no origin stories or 'the time I…' that aren't in the operator's factual context",
    "    or brand. Vague anonymous anecdotes are just as fake: never 'one guy did X',",
    "    'another founder', 'someone I know' as filler. A referenced story must be TRUE",
    "    and concretely attributed (a friend, my cofounder, a specific person), else",
    "    drop it and make the point with a real opinion or argument.",
    "  - POSE AS AN ORACLE. The operator is still figuring this out, not a guru with",
    "    the answer. No 'here's the framework', 'the secret is', tidy confident wisdom.",
    "    Honest uncertainty ('what's worked for me so far', 'I'm still not sure') is",
    "    the goal.",
    "  - em dashes — use commas, periods, or parentheses.",
    "  - the contrastive-reframe / negative parallelism: 'X isn't Y, it's Z', 'X is A, not B', 'not just X, it's Y' ('raising $8M isn't a win, it's a countdown timer', 'a filter, not a handicap', 'the deciding, not the doing'). Do NOT define by negation. State the claim as a plain positive declarative and delete the rejected half. A rare deliberate contrast can be ok, but leaning on this antithesis as your default sentence shape is a top AI tell.",
    "  - 'hits different', 'lands well', 'the gap between…', 'curious to hear…'.",
    "  - choppy 'fragment. fragment. fragment.' filler.",
    "  - hashtag soup, or a hypey 'link in comments 👇' / 'DM me' CTA.",
    // anti-ai skill: the reader-mode families. A post is long enough for these to
    // actually cluster, unlike a 100-char reply, so they matter more here.
    "  - SIGNIFICANCE-MARKING META COMMENTARY (hard ban). Never write a sentence whose",
    "    only job is to tell the reader what another sentence meant or which part",
    "    mattered: 'that's the part that got me', 'the thing is', 'here's the thing',",
    "    'and that's the point', 'which is exactly the problem', 'let that sink in',",
    "    'what got me was', 'that's what kills me'. This is the narrator stepping",
    "    outside the post to frame it, and it is the most reliable AI tell there is.",
    "    If a detail is the point, hit the detail again. Never label it.",
    "  - the rule of three ('fast, reliable, and scalable'; triads of adjectives or",
    "    clauses, especially in consecutive sentences). Keep the best item, or two, or",
    "    four with one oddly specific.",
    "  - rhetorical Q&A ('The result? Painful.' / 'Why? Because…') and false suspense",
    "    ('here's the kicker', 'here's where it gets interesting', 'the best part?').",
    "    Deliver the content, delete the drumroll.",
    "  - copula dodges (serves as, stands as, represents, functions as, boasts) — write",
    "    'is'. And participial tails ('…, underscoring its role', '…, highlighting the",
    "    importance of') — delete them or promote them to a real claim.",
    "  - vague authority ('studies show', 'experts say') — name the source or own it as",
    "    your own read. And invented concept labels ('the supervision paradox') — a",
    "    coined compound posing as an established term. Say it in plain words.",
    "  - grandiosity ('pivotal moment', 'defines the next era', 'paradigm shift').",
    "    Scale claims to what you actually know; mundane is credible.",
    "  - tier-1 AI vocabulary, zero hits: delve, leverage, utilize, facilitate,",
    "    streamline, bolster, showcase, elevate, empower, unleash, harness, foster,",
    "    garner, revolutionize, transcend, underpin, underscore, exemplify, tapestry,",
    "    realm, paradigm, synergy, testament, beacon, interplay, intricacies, myriad,",
    "    plethora, endeavor, pivotal, seamless, vibrant, intricate, meticulous, nuanced,",
    "    cutting-edge, transformative, game-changing, groundbreaking, unparalleled,",
    "    invaluable, multifaceted, unwavering, timeless, ever-evolving, fast-paced. Plus",
    "    'in today's fast-paced…', 'it's important to note', 'at its core', 'a key",
    "    takeaway', 'paving the way', 'valuable insights', 'shed light on',",
    "    'furthermore', 'moreover', 'in conclusion', 'let's unpack'. Use the word you'd",
    "    say out loud, or a concrete noun from the real situation.",
    "  - a signposted conclusion ('In conclusion', 'Overall,') or a pep-talk ending",
    "    ('As we move forward, embracing X will be key'). End on the last concrete",
    "    point, not a recap and not uplift.",
    "  - fractal summaries: previewing what you're about to say, then recapping it.",
    "    Say it once, where it lands hardest.",

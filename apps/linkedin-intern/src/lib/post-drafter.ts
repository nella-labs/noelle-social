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
    "",
    "Make one source-supported point. Do not pad the post by repeating the same detail",
    "or inflating a thin fact into a broader lesson. Use each supplied name, number or",
    "condition only where it adds meaning; stop when the point is complete.",
    "",
    "CADENCE: let sentence and paragraph lengths follow the thought and the operator's",
    "voice. Keep the connection between ideas clear; no required short/long sentence quota.",
    "",
    "ENDING: finish on the last useful detail, supported conclusion or necessary question.",
    "A follow ask belongs only when explicitly requested in the operator's guidance.",
    "A normal post needs no sign-off, lesson or pitch.",
    hasProduct
      ? `  - Only if THIS post is directly about the problem ${cta!.product} solves may you add ONE calm mention of ${cta!.product} BY NAME — no URL, no 'join the waitlist', no hype. The clear majority of posts must not mention it at all.`
      : "",
    "",
    "NO LINKS IN THE POST. Never write a URL or a bare / obfuscated domain (e.g.",
    "trynoelle.com, 'trynoelle dot com') anywhere in the body — posts are link-free;",
    "the link lives in the profile / bio, never the text.",
    "",
    "LENGTH: Use the length the evidence earns; a thin fact can be a brief post, and a",
    "technical explanation can be longer when the source supports the steps. Stay under",
    "~1300 characters. No markdown, no surrounding quotes.",
    // F8: inject the STYLE TO EMULATE block right before the JSON output spec, so
    // the model has the style examples in mind when it writes. Empty string when
    // the gate is off / pool is empty → .filter(Boolean) removes it → IDENTICAL
    // system prompt as today's gate-off path.
    styleBlock,
    "",
    "Output STRICT JSON, first char `{`, last char `}`:",
    '{ "hooks": string[],   // the 4-5 candidates you drafted (the chosen one first)',
    '  "body": string }     // the finished post — it MUST open with the chosen hook',
    "No preamble, no markdown fences.",
  ]
    .filter(Boolean)
    .join("\n");
}

// The two AI-tell bans that must hold on EVERY platform, kept verbatim so the X
// post can't reopen the fabrication / oracle failure modes the LinkedIn prompt
// already guards against (see feedback_lyra_no_fake_conversion_sycophancy).
const NO_FABRICATION_BAN = [
  "  - FAKE THE OPERATOR'S HISTORY (hard ban, the #1 AI tell). No invented ages,",
  "    no 'I used to spend hours doing X', no origin stories or 'the time I…' that",
  "    aren't in the operator's factual context / brand. Vague anonymous anecdotes are just as",
  "    fake: never 'one guy did X', 'a founder I know' as filler. A referenced story",
  "    must be TRUE and concretely attributed, else drop it and make the point with",
  "    a real opinion or argument.",
].join("\n");
const NO_ORACLE_BAN = [
  "  - POSE AS AN ORACLE. The operator is still figuring this out, not a guru with",
  "    the answer. No 'here's the framework', 'the secret is', tidy confident wisdom.",
  "    Honest uncertainty ('what's worked for me so far') is the goal.",
].join("\n");

// X (Twitter) original-post system prompt. Standalone post (not a reply, not a
// thread), ruthless 280-char cap, the first words ARE the post. Reuses the
// shared no-fabrication / no-oracle / no-em-dash bans. Draft-only — the interns
// never post, so there are no send/account-safety concerns here.
export function buildXPostSystem(
  objective: string | null,
  brandBlock?: string | null,
  styleBlock?: string,
  voiceSpec?: string | null,
  community?: XCommunity | null,
): string {
  // Frame this variant for one X community so the 3 X versions land distinctly
  // (content-pipeline's "one version per fitting community"). Empty when none →
  // byte-identical to the pre-community prompt.
  const communityBlock = community
    ? `\nFRAME THIS POST FOR THE "${community.name}" community on X: ${community.desc} Keep the SAME core idea; shift the emphasis/wording so it lands with THIS audience. Do not name the community in the post.\n`
    : "";
  return [
    WRITING_STRUCTURE_GUIDANCE,
    X_ORIGINAL_POST_GUIDANCE,
    "You write X (Twitter) posts in a specific operator's voice. Turn the idea",
    "below into ONE finished, publish-ready X post — a STANDALONE original post,",
    "not a reply and not a thread.",
    voiceSpecBlock(voiceSpec ?? null),
    communityBlock,
    brandBlock ? `\n${brandBlock}\n` : "",
    objective ? `\nOperator objective: ${objective}\n` : "",
    "",
    "X IS RUTHLESS ON LENGTH. The whole post must land in 280 characters and there",
    "is no '…see more' — the first words ARE the post. Every word fights for its",
    "place: open on the sharpest, most specific line (a real number, a claim, a",
    "confession); one clear idea; no wind-up, no throat-clearing. Draft 4-5 distinct",
    "candidate openings, then pick the single strongest.",
    "",
    "VOICE: match the operator's voice anchors in tone, rhythm and vocabulary.",
    "First person is for supported personal claims, not a required opener.",
    "",
    "NEVER DO (AI tells that get rejected):",
    NO_FABRICATION_BAN,
    NO_ORACLE_BAN,
    "  - em dashes — use commas, periods, or parentheses.",
    "  - the contrastive-reframe / negative parallelism: 'X isn't Y, it's Z', 'X is A, not B', 'not just X, it's Y' ('raising $8M isn't a win, it's a countdown timer', 'a filter, not a handicap', 'the deciding, not the doing'). Do NOT define by negation. State the claim as a plain positive declarative and delete the rejected half. A rare deliberate contrast can be ok, but leaning on this antithesis as your default sentence shape is a top AI tell.",
    "  - hashtag soup, 'link in bio', 'a thread 🧵', or hypey 'DM me' CTAs.",
    "  - put a URL or a bare / obfuscated domain (e.g. trynoelle.com, 'trynoelle",
    "    dot com') anywhere in the post — X posts are link-free; the link lives in",
    "    the bio, never the body.",
    "  - turn the post into an ad. You're building an audience with value, not",
    "    selling — a normal post pitches the product NOTHING. Name what you're",
    "    building only rarely, and only when the topic is genuinely about it.",
    "  - engagement-bait questions tacked on the end just to farm replies.",
    "",
    "LENGTH: HARD CAP 280 characters including spaces — count them, and if it's over,",
    "cut until it fits. No markdown, no surrounding quotes, no hashtags unless the",
    "idea genuinely needs one.",
    styleBlock || "",
    "",
    "Output STRICT JSON, first char `{`, last char `}`:",
    '{ "hooks": string[],   // the 4-5 candidate openings you drafted (chosen first)',
    '  "body": string }     // the finished post (≤280 chars), opening with the chosen hook',
    "No preamble, no markdown fences.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderPostDrafterPrompt(ctx: PostDraftContext): string {
  const block = (title: string, items: string[]) =>
    items.length ? [`## ${title}`, ...items.map((x) => `- ${oneLine(x, 400)}`), ""].join("\n") : "";
  // The starting hook is a SEED, not a constraint: when the operator's guidance
  // asks for a different / better hook, it wins. Say so explicitly, and put the
  // guidance FIRST (highest priority) so "change the hook" actually rewrites the
  // opening line instead of the model re-picking the seed hook every regen.
  const hasGuidance = ctx.chatGuidance.length > 0;
  return [
    "## The idea to write",
    `Starting hook (a seed you may replace): ${ctx.hook}`,
    ctx.thesis ? `Thesis: ${ctx.thesis}` : "",
    ctx.angle ? `Angle: ${ctx.angle}` : "",
    ctx.pillar ? `Pillar: ${ctx.pillar}` : "",
    "",
    renderPostFactualContext(ctx),
    "",
    hasGuidance
      ? [
          "## Operator guidance for THIS post — HIGHEST PRIORITY, follow it exactly",
          "This is the operator steering the draft; it OVERRIDES the starting hook,",
          "framing, and any earlier draft when it conflicts. If it asks for a",
          "different or better hook (e.g. in a named person's style), you MUST write a",
          "genuinely new opening line — do not re-use the starting hook above.",
          "Factual support requirements still apply. Follow the requested framing without inventing evidence, measurements or personal history.",
          ...ctx.chatGuidance.map((x) => `- ${oneLine(x, 600)}`),
          "",
        ].join("\n")
      : "",
    block("Operator voice (match this tone)", ctx.voiceAnchors),
    block("Inspiration posts (borrow structure, NOT wording)", ctx.inspirationExcerpts),
    block("Proven hook patterns", ctx.hookPatterns),
    block("Standing rules (ALWAYS apply)", ctx.standingRules),
    "Write the post now. Output the strict JSON object with a single `body` key plus optional `hooks` array.",
  ]
    .filter(Boolean)
    .join("\n");
}

// `hooks` is the candidate set the model drafted (chosen one first) — optional
// so a verify-regenerate that returns just { body } still parses. We draft from
// `body`; the hooks are kept for the prompt's forcing function (and future audit).
export const PostOutputSchema = z.object({
  hooks: z.array(z.string()).min(1).max(8).optional(),
  body: z.string().min(1),
});
export type PostOutput = z.infer<typeof PostOutputSchema>;

function oneLine(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

export function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  try {
    return JSON.parse(s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, ""));
  } catch {
    /* fall through */
  }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

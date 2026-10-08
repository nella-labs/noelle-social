import {
  IDEA_WRITING_GUIDANCE,
  WRITING_STRUCTURE_GUIDANCE,
  X_ORIGINAL_POST_GUIDANCE,
  type RepliedPostSource,
} from "@noelle/runtime";
import { z } from "zod";
import type { PostIdeaIn, InspirationRef } from "@noelle/contracts";
import { SAVED_POSTS_PER_AUTHOR } from "./saved-author-engagement.js";
import {
  renderOwnPerformanceBlock,
  hasOwnPerformanceRecommendations,
  type OwnPerformance,
} from "./own-performance.js";

// X (twitter) posts ideation — pure logic (source tagging, prompt, parse, ref
// resolution, weekly-day assignment). Side-effect-free so it's unit-testable
// without a DB, Apify, or an LLM. The gather (saved DB/KB reads), the model call,
// and the sink live in workers/ideation-tick.ts + workers/ideation.ts.
//
// This is the X-native sibling of apps/linkedin-intern/src/lib/ideation.ts. It
// is a deliberate per-intern copy (the repo already duplicates the apify pool +
// KB setup per intern) with two differences: an X content-strategist prompt
// (single-post vs thread, X hook norms, no LinkedIn-isms) and engagement read as
// likes/reposts/replies instead of reactions/comments. X v1 has THREE sources
// (no playbooks/engagement-analyst yet):
//   1. watchlist engagement mining — top watched authors' best posts
//   2. net-new viral search        — high-engagement posts by people NOT engaged
//   3. vault voice + content pillars

/** A watched author's recent best posts (the "topic radar" source). */
export interface AuthorEngagement {
  authorHandle: string;
  authorName: string | null;
  /** Average complete measured totals in a bounded recent saved-post sample. */
  avgEngagement: number | null;
  observedPostCount: number;
  measuredPostCount: number;
  samplePosts: Array<{
    externalId: string | null;
    url: string | null;
    text: string;
    likes: number | null;
    reposts: number | null;
    replies: number | null;
  }>;
}

/** One net-new viral post returned by the keyword search. */
export interface KeywordPost {
  id: string;
  text: string;
  url: string;
  author: string | null;
  likes: number;
  reposts: number;
  replies: number;
}

export interface IdeationGather {
  /** Posts the operator already replied to, paired with the exact public reply they accepted. */
  repliedPosts?: RepliedPostSource[];
  topAuthors: AuthorEngagement[];
  keywordPosts: KeywordPost[];
  /** Voice/knowledge snippets from the vault (grounding the operator's voice). */
  voiceAnchors: string[];
  /** Content pillars the operator posts around (from env config). */
  pillars: string[];
  /**
   * The LEARN signal: the operator's OWN published posts, measured and rolled up
   * by pillar/angle. Null until enough own posts have been tracked (the loop is
   * X-only — draft-only agents never publish). Biases idea selection toward what
   * already performs for this operator.
   */
  ownPerformance?: OwnPerformance | null;
}

/** Total engagement signal for an X post. */
function engagement(p: { likes: number; reposts: number; replies: number }): number {
  return (p.likes ?? 0) + (p.reposts ?? 0) + (p.replies ?? 0);
}

/**
 * Rank the net-new keyword-search posts so ideation borrows structure from the
 * VIRAL ones, and only from people the operator has NOT engaged.
 *
 *  - drops posts whose author is in `engagedHandles` (watchlist / already-drafted)
 *    so a connection never sees a post that looks copied from their own;
 *  - drops posts with no engagement signal (a viral teardown needs a post that
 *    actually performed);
 *  - sorts by total engagement (likes + reposts + replies) desc, caps at `limit`.
 *
 * Pure + deterministic so it's unit-testable without Apify.
 */
export function rankNetNewPosts(
  posts: KeywordPost[],
  engagedHandles: Set<string>,
  limit: number,
): KeywordPost[] {
  return posts
    .filter((p) => {
      const handle = (p.author ?? "").trim().toLowerCase().replace(/^@/, "");
      if (handle && engagedHandles.has(handle)) return false;
      return engagement(p) > 0;
    })
    .sort((a, b) => engagement(b) - engagement(a))
    .slice(0, Math.max(0, limit));
}

// A tagged source the LLM can cite by tag, so inspiration refs stay grounded in
// real posts instead of hallucinated URLs.
/**
 * Build the numbered context block + the tag→ref map. Each watchlist post gets a
 * [Wn] tag; each net-new keyword post a [Kn] tag. The model is asked to list
 * which tags inspired each idea; assembleIdeas resolves them.
 */
export function buildSources(gather: IdeationGather): {
  block: string;
  sources: Map<string, InspirationRef>;
} {
  const sources = new Map<string, InspirationRef>();
  const lines: string[] = [];

  lines.push(
    "## Posts the operator ALREADY replied to — best source for new ideas",
    "(start here when available: turn the operator's real reply + the source post into a standalone post idea; do NOT hunt for fresh viral posts)",
  );
  let ri = 0;
  for (const src of (gather.repliedPosts ?? []).slice(0, 12)) {
    ri++;
    const tag = `R${ri}`;
    sources.set(tag, {
      kind: "replied_post" as InspirationRef["kind"],
      leadId: src.leadId,
      url: src.url ?? undefined,
      author: src.author ?? undefined,
      note: oneLine(`operator replied: ${src.reply}`, 280),
    });
    lines.push(
      `[${tag}] ${src.author ? `@${src.author} ` : ""}post: ${oneLine(src.post, 260)}`,
      `     operator replied: ${oneLine(src.reply, 260)}`,
    );
  }
  if (ri === 0) lines.push("(none yet)");

  lines.push(
    "",
    "## Watchlist posts — people the operator ALREADY ENGAGES (reads/replies to)",
    "(use ONLY for topic radar; do NOT mirror these — a post that echoes someone the operator replies to looks copied to them)",
    `(bounded observed sample: up to ${SAVED_POSTS_PER_AUTHOR} recent saved posts per watched author; unknown counts are not zero or evidence of poor performance)`,
  );
  let wi = 0;
  for (const author of gather.topAuthors) {
    for (const post of author.samplePosts.slice(0, 3)) {
      wi++;
      const tag = `W${wi}`;
      sources.set(tag, {
        kind: "watchlist_post",
        leadId: post.externalId || undefined,
        url: post.url ?? undefined,
        author: author.authorName ?? author.authorHandle,
        note: watchlistCounts(post),
      });
      lines.push(
        `[${tag}] @${author.authorHandle} (${watchlistCounts(post)}): ${oneLine(post.text, 280)}`,
      );
    }
  }
  if (wi === 0) lines.push("(none yet)");

  lines.push(
    "",
    "## Net-new VIRAL posts in your field, by people you have NOT engaged",
    "(borrow the HOOK + STRUCTURE that made these perform — never the words, never @-mention them; the operator has no relationship with these authors)",
  );
  let ki = 0;
  for (const post of gather.keywordPosts) {
    ki++;
    const tag = `K${ki}`;
    sources.set(tag, {
      kind: "keyword_post",
      url: post.url || undefined,
      author: post.author ?? undefined,
      note: `${post.likes} likes, ${post.reposts} reposts, ${post.replies} replies`,
    });
    lines.push(
      `[${tag}] ${post.author ? `@${post.author} ` : ""}(${post.likes}♥/${post.reposts}↻/${post.replies}💬): ${oneLine(post.text, 280)}`,
    );
  }
  if (ki === 0) lines.push("(none — no net-new field posts available this run)");

  return { block: lines.join("\n"), sources };
}

export function buildIdeationSystem(
  objective: string | null,
  brandBlock?: string | null,
  ownPerformance?: OwnPerformance | null,
): string {
  const hasOwnPerf = hasOwnPerformanceRecommendations(ownPerformance);
  return [
    WRITING_STRUCTURE_GUIDANCE,
    IDEA_WRITING_GUIDANCE,
    X_ORIGINAL_POST_GUIDANCE,
    "You are an X (Twitter) content strategist for a specific operator. Propose",
    "post IDEAS — NOT finished posts — the operator could publish this week. Each",
    "idea must have a scroll-stopping hook and a clear point that works on X.",
    brandBlock ? `\n${brandBlock}\n` : "",
    objective ? `\nOperator objective: ${objective}\n` : "",
    "The brand / product / objective context above grounds WHO the operator is and",
    "how they talk — it is NOT a list of topics and NOT a mandate to pitch. What",
    "they're building is their day job that once in a while informs a take, never the",
    "subject of the feed. Even if the objective mentions growth or the product, the",
    "feed is mostly the operator's opinions about the world — not an ad. The",
    "overwhelming majority of ideas must have nothing to do with the product.",
    "You are given (a) the operator's VOICE and content PILLARS, (b) [R] posts the",
    "operator already replied to, paired with the exact public reply they sent,",
    "(c) [W] posts from people the operator already engages, and (d) [K] cached",
    "net-new field posts if any were already available. START from [R] when present:",
    "the operator's real reply is the strongest signal for what they actually care",
    "about. Turn that exchange into a standalone post idea. BORROW structure and",
    "angle — NEVER copy wording. Ideas must sound like the operator.",
    "",
    "WRITE FOR X, NOT LINKEDIN. X rewards a sharp first line, a strong point of view,",
    "and brevity. The hook is one or two lines that earn the expand/like. Think in",
    "single posts; only suggest a thread when the idea genuinely needs steps or a",
    "list. NO LinkedIn tells: no 'Agree?', no '\\n\\n' inspirational-cadence walls, no",
    "'Here's why 🧵' clickbait unless it's truly a thread, no corporate hashtags, no",
    "humblebrag 'grateful/honored' framing. Lowercase, dry, and specific beats",
    "polished and motivational on X.",
    "",
    "SOURCE THE POV FROM WHAT THE OPERATOR ALREADY REPLIED TO. Most ideas should",
    "come from [R] when [R] exists: preserve the operator's real point of view and",
    "detach it from the original author's scaffolding. [K] posts are only cached",
    "field examples when present, useful for hook shape. The [W] watchlist posts",
    "are people the operator publicly reads and replies to — do NOT anchor ideas on",
    "them; if your idea echoes a [W] post, that person will think the operator copied",
    "them. At MOST one idea may lean on a [W] topic, and even then only the topic,",
    "never the take.",
    "",
    "VOICE & TRUTH — NON-NEGOTIABLE. The operator publishes these themselves, so",
    "write from their perspective. Use first person for supported personal claims; never write about",
    "the operator in the third person and NEVER use their name as a character.",
    "",
    "FAKING YOUR OWN HISTORY IS A HARD BAN — it is the #1 AI tell. Do NOT invent a",
    "personal backstory for the operator: no made-up ages ('when I was 17'), no",
    "'I mass-applied to 40 things', 'I spent hours doing X', 'the time I…', no",
    "first-time/origin stories — unless that exact fact is in the operator factual context or",
    "brand below. THIS COVERS CURRENT FACTS, NOT JUST BACKSTORY: never state the",
    "operator's AGE ('i'm 22'), location, years of experience, team size, or revenue",
    "unless that EXACT fact is in the vault / brand. If the vault doesn't say it, you",
    "do NOT know it — make the point without the invented detail. And NEVER lift a",
    "personal fact from a [W] / [K] source post; that is THEIR life, not the operator's.",
    "Vague anonymous anecdotes are just as bad: never 'one guy did X',",
    "'a founder I know', 'someone I talked to' as invented filler. If you reference a",
    "real story it must be TRUE and concretely attributed — otherwise drop the story",
    "and make the point with an opinion, observation, or argument. A fabricated",
    "memory is far worse than no memory.",
    "",
    "DON'T POSE AS AN ORACLE. The operator is still figuring this out, NOT a guru who",
    "has it all solved. Avoid 'here's the framework', 'the secret is…', tidy 3-step",
    "wisdom and clean confident conclusions. Honest uncertainty reads real; fake",
    "authority reads like slop.",
    "",
    "DON'T DEFINE BY NEGATION — THE CONTRASTIVE-REFRAME CRUTCH IS A HARD-FLAG. The",
    "single most over-used shape in past batches is the antithesis reframe: 'X isn't",
    "Y, it's Z' / 'X is A, not B' / 'not just X, it's Y' ('raising $8M isn't a win,",
    "it's a countdown timer', 'being outside the scene is a filter, not a handicap',",
    "'the real work is the deciding, not the doing'). It reads as a top AI tell. Do",
    "NOT build a hook or thesis on it. State the claim as a plain positive declarative",
    "and delete the rejected half. The quality gate checks every hook and thesis;",
    "there is no per-batch exception for this sentence shape.",
    "",
    "THE HOOK IS THE WHOLE POINT. The operator picks ideas by their hook alone, so",
    "the hook IS the deliverable — spend your effort there. Every hook must:",
    "  - be specific and concrete (a real number, moment, or stake), never generic;",
    "  - make the supported point clear in the first 8 words (a concrete constraint,",
    "    an honest observation, a supplied result or a useful question);",
    "  - have zero throat-clearing ('I've been thinking…', 'Here's a thought…').",
    "Make each idea use a DIFFERENT hook pattern.",
    "",
    "BREADTH — THE OPERATOR IS A WHOLE PERSON, NOT A PRODUCT FEED. This is the #1",
    "failure mode and the operator has explicitly complained about it: every idea",
    "keeps ending up about the product / building an AI company / 'agents that do your",
    "work'. STOP. The operator has opinions about their whole world — the BS in their",
    "industry, money and career, culture, taste, what's overrated, a thing that",
    "annoyed or amused them today. Write THOSE. Their best posts have NOTHING to do",
    "with what they sell.",
    "  - HARD CAP: AT MOST ONE idea in the whole batch may touch the product or the",
    "    fact that they're building a company. EVERY OTHER idea must not mention it —",
    "    not the product, not 'agents', not 'I'm building X', not 'AI tools' as a",
    "    setup — AT ALL.",
    "  - A real OPINION about their craft is fine occasionally, but that is NOT the",
    "    same as pitching what they build. Keep even those a minority.",
    "HARD BAN on lazy builder/pitch hooks: 'I deleted N lines of code', 'building in",
    "public day N', 'as a founder…', 'every AI tool made me…', 'what I actually want",
    "is agents that…', 'I'm the bottleneck at my own company'. Lead with a take on the",
    "WORLD, a human stake — not their startup, not a dev-log.",
    "",
    hasOwnPerf
      ? [
          "LEARN FROM SUPPORTED OWN-POST PATTERNS. Use only pillars and angles",
          "explicitly supported as recommendations in the measured outcomes block.",
          "Preserve sample counts, the comparison basis and missing metrics. Counts",
          "without exposure are weaker evidence than comparable measured rates.",
          "These observations do not establish that a topic or format caused reach.",
          "Use the pattern to explore a fresh relevant point; never rewrite, echo",
          "or continue a specific past post. Keep variety within the topic focus.",
          "",
        ].join("\n")
      : "Sparse measurements are observations, not winning patterns. Keep exploring relevant pillars and angles without declaring a winner or attributing reach to a format.",
    "For each idea cite the source tags ([R#]/[W#]/[K#]) that inspired it.",
    "",
    "Output STRICT JSON, first char `{`, last char `}`:",
    '{ "ideas": [ {',
    '  "hook": string,           // the opening line, punchy',
    '  "thesis": string,         // 1-2 sentences: the point of the post',
    '  "angle": string,          // contrarian | story | how_to | observation | ...',
    '  "pillar": string,         // which content pillar (from the operator pillars)',
    '  "inspiration_tags": string[]  // e.g. ["R2","K1"]; [] if purely from voice',
    "} ] }",
    "No preamble, no markdown fences.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderIdeationPrompt(
  gather: IdeationGather,
  opts: { count: number; topics?: string[] },
): string {
  const { block } = buildSources(gather);
  const ownPerfBlock = renderOwnPerformanceBlock(gather.ownPerformance);
  return [
    `Propose ${opts.count} X post ideas.`,
    "",
    "## Operator voice (match this)",
    gather.voiceAnchors.length
      ? gather.voiceAnchors.map((a) => `- ${oneLine(a, 240)}`).join("\n")
      : "(no voice anchors found)",
    "",
    "## Operator content pillars",
    gather.pillars.length ? gather.pillars.map((p) => `- ${p}`).join("\n") : "(none specified — infer from voice)",
    opts.topics && opts.topics.length
      ? `\n## Bias this run toward these topics\n${opts.topics.map((t) => `- ${t}`).join("\n")}`
      : "",
    ownPerfBlock ? `\n${ownPerfBlock}` : "",
    "",
    block,
    "",
    `Output the strict JSON with exactly ${opts.count} ideas.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const IdeaSynthSchema = z.object({
  ideas: z
    .array(
      z.object({
        repair_id: z.number().int().nonnegative().optional(),
        hook: z.string().min(1),
        thesis: z.string().default(""),
        angle: z.string().default(""),
        pillar: z.string().default(""),
        inspiration_tags: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});
export type IdeaSynth = z.infer<typeof IdeaSynthSchema>;

/**
 * Resolve the model's parsed ideas into wire-ready PostIdeaIn cards: map the
 * cited tags to real InspirationRefs, generate ids, stamp engine/model/batch,
 * and (for a weekly batch) assign each idea a Mon-Sun day from weekStart. The
 * idea's home platform is always "x" (Vega owns the row); the fan-out scope is
 * `opts.targetPlatforms` (defaults to ["x"]).
 */
export function assembleIdeas(
  parsed: IdeaSynth,
  sources: Map<string, InspirationRef>,
  opts: {
    idFactory: () => string;
    sourceEngine: string;
    model: string;
    batchId?: string | null;
    /** Monday (YYYY-MM-DD) for batch mode; assigns day i to weekStart + i. */
    weekStart?: string | null;
    /** Platforms each idea fans out into. Defaults to ["x"] (X-only). */
    targetPlatforms?: string[] | null;
  },
): PostIdeaIn[] {
  const targetPlatforms = (opts.targetPlatforms?.length
    ? opts.targetPlatforms
    : ["x"]) as PostIdeaIn["targetPlatforms"];
  return parsed.ideas.map((idea, i) => {
    const refs: InspirationRef[] = [];
    const seen = new Set<string>();
    for (const tag of idea.inspiration_tags) {

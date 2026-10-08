import { IDEA_WRITING_GUIDANCE, WRITING_STRUCTURE_GUIDANCE } from "@noelle/runtime";
import type { RepliedPostSource } from "@noelle/runtime";
import { z } from "zod";
import type { PostIdeaIn, InspirationRef } from "@noelle/contracts";
import type { AuthorEngagement } from "./engagement-analyst.js";
import type { PlaybookRow } from "./playbooks-db.js";

// Posts ideation — pure logic (source tagging, prompt, parse, ref resolution,
// weekly-day assignment). Side-effect-free so it's unit-testable without a DB,
// Apify, or an LLM. The gather (DB/Apify/KB reads) + the model call + the sink
// live in workers/ideation-tick.ts.
//
// The operator's ideation sources (all saved locally except voice search):
//   1. replied posts              — public posts Noelle already replied to
//   2. watchlist engagement mining — top authors' cached best posts
//   3. net-new keyword search      — legacy/backcompat source, no longer read by
//                                    the LinkedIn worker directly
//   4. vault cadence + pillars     — voice anchors + content pillars
//   5. top-performer teardown      — cached Engagement Analyst playbooks

export interface KeywordPost {
  id: string;
  text: string;
  url: string;
  author: string | null;
  reactions: number;
  comments: number;
}

/**
 * Rank the net-new keyword-search posts so ideation borrows structure from the
 * VIRAL ones, and only from people the operator has NOT engaged.
 *
 *  - drops posts whose author is in `engagedHandles` (watchlist / already-drafted)
 *    so a connection never sees a post that looks copied from their own;
 *  - drops posts with no real engagement signal (a viral teardown needs a post
 *    that actually performed);
 *  - sorts by total engagement (reactions + comments) desc and caps at `limit`.
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
      const handle = (p.author ?? "").trim().toLowerCase();
      if (handle && engagedHandles.has(handle)) return false;
      return (p.reactions ?? 0) + (p.comments ?? 0) > 0;
    })
    .sort((a, b) => b.reactions + b.comments - (a.reactions + a.comments))
    .slice(0, Math.max(0, limit));
}

export interface IdeationGather {
  /** Saved post + accepted public reply pairs from Noelle's own database. */
  repliedPosts?: RepliedPostSource[];
  topAuthors: AuthorEngagement[];
  keywordPosts: KeywordPost[];
  playbooks: PlaybookRow[];
  /** Voice/knowledge snippets from the vault (grounding the operator's voice). */
  voiceAnchors: string[];
  /** Content pillars the operator posts around (from the vault config). */
  pillars: string[];
}

// A tagged source the LLM can cite by tag, so inspiration refs stay grounded in
// real posts/playbooks instead of hallucinated URLs.
interface TaggedSource {
  tag: string;
  ref: InspirationRef;
}

/**
 * Build the numbered context block + the tag→ref map. Each watchlist post and
 * keyword post gets a [Wn]/[Kn] tag; each playbook a [Pn] tag. The model is
 * asked to list which tags inspired each idea; assembleIdeas resolves them.
 */
export function buildSources(gather: IdeationGather): {
  block: string;
  sources: Map<string, InspirationRef>;
} {
  const sources = new Map<string, InspirationRef>();
  const lines: string[] = [];

  lines.push(
    "## Saved replied posts — posts Noelle ALREADY answered publicly",
    "(prefer these as your primary idea fuel: they show the operator's taste, voice, and what they chose to engage; never copy the source author's wording or pretend their story is the operator's)",
  );
  let ri = 0;
  for (const post of gather.repliedPosts ?? []) {
    ri++;
    const tag = `R${ri}`;
    sources.set(tag, {
      kind: "replied_post" as InspirationRef["kind"],
      leadId: post.leadId,
      url: post.url ?? undefined,
      author: post.author ?? undefined,
      note: post.repliedAt ? `operator replied ${post.repliedAt}`.slice(0, 200) : "operator replied",
    });
    lines.push(
      `[${tag}] ${post.author ? `@${post.author} ` : ""}post: ${oneLine(post.post, 240)} | operator replied: ${oneLine(post.reply, 180)}`,
    );
  }
  if (ri === 0) lines.push("(none yet)");

  lines.push("");
  lines.push(
    "## Watchlist posts — people the operator ALREADY ENGAGES (reads/replies to)",
    "(use ONLY for topic radar; do NOT mirror these — a post that echoes someone the operator comments on looks copied to them)",
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
        note: `${post.reactions} reactions, ${post.comments} comments`,
      });
      lines.push(
        `[${tag}] @${author.authorHandle} (${post.reactions}r/${post.comments}c): ${oneLine(post.text, 280)}`,
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
      note: `${post.reactions} reactions, ${post.comments} comments`,
    });
    lines.push(`[${tag}] ${post.author ? `@${post.author} ` : ""}(${post.reactions}r/${post.comments}c): ${oneLine(post.text, 280)}`);
  }
  if (ki === 0) lines.push("(none — no net-new field posts available this run)");

  lines.push("", "## Top-performer playbooks (how the best people structure posts)");
  let pi = 0;
  for (const pb of gather.playbooks) {
    pi++;
    const tag = `P${pi}`;
    sources.set(tag, {
      kind: "playbook",
      author: pb.authorHandle,
      // Link a playbook ref to the author's LinkedIn profile so the operator can
      // open who the idea borrowed structure from (a playbook isn't one post, so
      // there's no single post URL — the profile is the right target).
      url: pb.authorHandle ? `https://www.linkedin.com/in/${pb.authorHandle}` : undefined,
      // Cap at the InspirationRef.note contract limit (280) — joined hook
      // patterns can run long and would otherwise fail the api-vm write.
      note: (pb.hookPatterns.slice(0, 3).join("; ") || "engagement playbook").slice(0, 200),
    });
    const hooks = pb.hookPatterns.slice(0, 4).join("; ");
    lines.push(`[${tag}] @${pb.authorHandle} hooks: ${hooks || "(n/a)"}; topics: ${pb.topTopics.slice(0, 5).join(", ")}`);
  }
  if (pi === 0) lines.push("(none yet)");

  return { block: lines.join("\n"), sources };
}

export function buildIdeationSystem(
  objective: string | null,
  brandBlock?: string | null,
): string {
  return [
    WRITING_STRUCTURE_GUIDANCE,
    IDEA_WRITING_GUIDANCE,
    "You are a LinkedIn content strategist for a specific operator. Propose post",
    "IDEAS — NOT finished posts — the operator could publish this week. Each idea",
    "must have a strong, scroll-stopping hook and a clear point.",
    // The operator's brand: who they are, the product, what it's about. The SAME
    // brand context the drafter writes with, so ideas are on-brand from the start
    // (not just on-voice). The drafter then writes the post with this same brand.
    brandBlock ? `\n${brandBlock}\n` : "",
    objective ? `\nOperator objective: ${objective}\n` : "",
    "The brand / product / objective context above grounds WHO the operator is and",
    "how they talk — it is NOT a list of topics and NOT a mandate to pitch. Treat what",
    "they're building as their day job that once in a while informs a take, never the",
    "subject of the feed. Even if the objective mentions growth or the product, the",
    "FEED is mostly the operator's opinions about the world — not an ad for what they",
    "sell. The overwhelming majority of ideas must have nothing to do with the product.",
    "You are given (a) the operator's VOICE and content PILLARS, (b) [R] saved",
    "posts Noelle already replied to publicly, (c) [W] cached posts from people the",
    "operator already engages, (d) [K] net-new VIRAL posts when available, and (e)",
    "[P] cached playbooks of how top performers structure posts. Prefer [R]",
    "sources: they are the operator's saved engagement history. BORROW the structure",
    "and angle — NEVER copy wording. Ideas must sound like the operator.",
    "",
    "SAVED REPLIED POSTS ARE EVIDENCE, NOT A SCRIPT. Use [R] sources to infer the",
    "operator's taste: which tensions they answer, what details they notice, and how",
    "they turn a post into a take. Do NOT impersonate the source author. Do NOT lift",
    "their biography, numbers, claims, or story as the operator's life. Rebuild the",
    "idea from the operator's point of view and only cite [R] tags that actually",
    "inspired the hook/thesis.",
    "",
    "SOURCE THE VIRALITY, NOT YOUR OWN FEED. Most ideas should be NET-NEW: take the",
    "HOOK SHAPE that made a [K] field post or a [P] playbook go viral and rebuild it",
    "around the operator's own angle/pillar. The [W] watchlist posts are people the",
    "operator publicly reads and replies to — do NOT anchor ideas on them; if your",
    "idea echoes a [W] post, that person will think the operator copied them. At MOST",
    "one idea may lean on a [W] topic, and even then only the topic, never the take.",
    "Prefer [K]/[P] structure. The hook is where virality lives — adapt a proven hook",
    "pattern from the SAME field, make it the operator's own, and never reuse wording.",
    "",
    "VOICE & TRUTH — NON-NEGOTIABLE. The operator publishes these posts themselves,",
    "so write from their perspective. Use first person for supported personal claims; never write about",
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
    "real story it must be TRUE and concretely attributed (a friend, my cofounder, a",
    "specific person) — otherwise drop the story and make the point with an opinion,",
    "observation, or argument. A fabricated memory is far worse than no memory.",
    "",
    "DON'T POSE AS AN ORACLE. The operator is still figuring this out, NOT a guru who",
    "has it all solved. Avoid 'here's the framework', 'the secret is…', tidy 3-step",
    "wisdom and clean confident conclusions. Honest uncertainty ('I'm still not sure',",
    "'what's worked for me so far', 'I might be wrong') reads real; fake authority",
    "reads like LinkedIn slop.",
    "",
    "THE HOOK IS THE WHOLE POINT. The operator picks ideas by their hook alone, so",
    "the hook IS the deliverable — spend your effort there. Every hook must:",
    "  - be specific and concrete (a real number, moment, or stake), never generic;",
    "  - create tension or curiosity in the first 8 words (contrarian claim, a",
    "    confession, a surprising result, a 'stop doing X');",
    "  - have zero throat-clearing ('I've been thinking…', 'Here's a thought…').",
    "Mine the PROVEN HOOK PATTERNS (distilled from the highest-engagement posts in",
    "the operator's network) and the engagement numbers — those patterns are what",
    "demonstrably works here. Make each of the ideas use a DIFFERENT hook pattern.",
    "",
    "BREADTH — THE OPERATOR IS A WHOLE PERSON, NOT A PRODUCT FEED. This is the #1",
    "failure mode and the operator has explicitly complained about it: every idea",
    "keeps ending up about the product / building an AI company / 'agents that do your",
    "work'. STOP DOING THAT. The operator has opinions about their whole world — the",
    "BS in their industry, money and career, culture, relationships, taste, what's",
    "overrated, lessons from outside tech, a thing that annoyed or amused them today.",
    "Write THOSE. Their best posts have NOTHING to do with what they sell.",
    "  - HARD CAP: AT MOST ONE idea in the entire batch may touch the product or the",
    "    fact that they're building a company. EVERY OTHER idea must not mention it —",
    "    not the product, not 'agents', not 'I'm building X', not the founder-grind,",
    "    not 'AI tools' as a setup — AT ALL. If you're unsure, it's a no.",
    "  - A genuine OPINION about their craft is fine occasionally, but that is NOT the",
    "    same as pitching what they build. Keep even those a minority.",
    "HARD BAN on lazy builder/pitch hooks: 'I deleted N lines of code', 'I shipped X",
    "features', 'building in public day N', 'as a founder…', 'every AI tool made me…',",
    "'what I actually want is agents that…', 'I'm the bottleneck at my own company'.",
    "Nobody follows a person to read their pitch. Lead with a take on the WORLD, a",
    "human stake — not their startup, not a dev-log.",
    "",
    "For each idea cite the source tags ([R#]/[W#]/[K#]/[P#]) that actually inspired it.",
    "",
    "Output STRICT JSON, first char `{`, last char `}`:",
    '{ "ideas": [ {',
    '  "hook": string,           // the opening line, punchy',
    '  "thesis": string,         // 1-2 sentences: the point of the post',
    '  "angle": string,          // contrarian | story | how_to | observation | ...',
    '  "pillar": string,         // which content pillar (from the operator pillars)',
    '  "inspiration_tags": string[]  // e.g. ["W2","P1"]; [] if purely from voice',
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
  return [
    `Propose ${opts.count} post ideas.`,
    "",
    "## Operator voice (match this)",
    gather.voiceAnchors.length ? gather.voiceAnchors.map((a) => `- ${oneLine(a, 240)}`).join("\n") : "(no voice anchors found)",
    "",
    `## Operator content pillars`,
    gather.pillars.length ? gather.pillars.map((p) => `- ${p}`).join("\n") : "(none specified — infer from voice)",
    opts.topics && opts.topics.length ? `\n## Bias this run toward these topics\n${opts.topics.map((t) => `- ${t}`).join("\n")}` : "",
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
 * and (for a weekly batch) assign each idea a Mon-Sun day from weekStart.
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
    /** Platforms each idea fans out into (one draft per entry). Defaults to the
     *  cross-platform linkedin+x fan-out so the "All" lane is unchanged. A
     *  lane-scoped run passes a single platform (e.g. ["linkedin"]). */
    targetPlatforms?: string[] | null;
  },
): PostIdeaIn[] {
  const targetPlatforms = (opts.targetPlatforms?.length
    ? opts.targetPlatforms
    : ["linkedin", "x"]) as PostIdeaIn["targetPlatforms"];
  return parsed.ideas.map((idea, i) => {
    const refs: InspirationRef[] = [];
    const seen = new Set<string>();
    for (const tag of idea.inspiration_tags) {
      const ref = sources.get(tag.trim().toUpperCase());
      if (ref && !seen.has(tag)) {
        // Defensive: never let an over-long note fail the api-vm write (the
        // InspirationRef.note contract caps at 280).
        refs.push(ref.note && ref.note.length > 280 ? { ...ref, note: ref.note.slice(0, 280) } : ref);
        seen.add(tag);
      }
    }
    return {
      id: opts.idFactory(),
      // The idea's HOME platform — the owning instance is the LinkedIn intern, so
      // home stays "linkedin". The fan-out is `targetPlatforms` below.
      platform: "linkedin",
      // Which platforms this idea fans out into (one draft per entry). The "All"
      // lane defaults to the cross-platform linkedin+x set; a lane-scoped run
      // (e.g. the LinkedIn lane) passes a single platform via opts.
      targetPlatforms,
      hook: idea.hook.slice(0, 600),
      thesis: idea.thesis ? idea.thesis.slice(0, 1200) : null,
      angle: idea.angle ? idea.angle.slice(0, 60) : null,
      pillar: idea.pillar ? idea.pillar.slice(0, 120) : null,
      inspirationRefs: refs.slice(0, 12),
      suggestedDay: opts.weekStart ? addDays(opts.weekStart, i) : null,
      batchId: opts.batchId ?? null,
      sourceEngine: opts.sourceEngine,
      model: opts.model,
    };
  });
}

/** YYYY-MM-DD + n days, as YYYY-MM-DD (UTC, no Date.now needed). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function oneLine(s: string | null, max: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Tolerant JSON parse (raw / fenced / first-brace-to-last). */
export function safeJsonParse(s: string): unknown {
  try {

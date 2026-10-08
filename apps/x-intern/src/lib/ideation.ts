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

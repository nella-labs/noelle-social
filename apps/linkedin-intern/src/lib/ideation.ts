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

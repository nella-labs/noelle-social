import { z } from "zod";
import { SAVED_POSTS_PER_AUTHOR } from "./saved-author-engagement.js";

// Engagement Analyst (X / Vega) — pure logic (ranking, percentiles, prompt, parse).
//
// Reads the REAL engagement already captured on watchlist people's posts
// (noelle.leads payload.likes / .replies / .reposts — X's three counts, where
// LinkedIn has two) and describes the measured cohort in a reusable playbook:
// the hook patterns, post structure, length and topics observed in that bounded
// sample. Feeds Vega's ideation lane and the drafter.
//
// Ported from Lyra. The playbooks land in the SAME shared
// noelle.watchlist_playbooks table (keyed by agent_instance_id + author_handle),
// so no migration is needed — only the engagement query and the prompt's
// platform wording differ.
//
// This module is deliberately side-effect-free so the ranking + parsing is
// unit-testable without a DB or an LLM. The DB reads/writes live in
// leads-engagement-db.ts / playbooks-db.ts and the orchestration in
// workers/analyst-tick.ts.

export interface SamplePost {
  externalId: string;
  text: string | null;
  url: string | null;
  /** X splits engagement three ways; LinkedIn has only reactions + comments. */
  likes: number;
  replies: number;
  reposts: number;
}

export interface AuthorEngagement {
  authorHandle: string;
  authorId: string | null;
  authorName: string | null;
  authorHeadline: string | null;
  postCount: number;
  observedPostCount: number;
  avgEngagement: number;
  totalEngagement: number;
  samplePosts: SamplePost[];
}

/**
 * Percentile (0-1) for each author by their rank in the engagement-sorted list.
 * Distinct first → 1, last → 0; ties share their rank span's average percentile.
 * A single author is first (1); this is a rank within the measured cohort.
 * Input MUST already be sorted best-first (as getWatchlistAuthorEngagement
 * returns it). Keyed by authorHandle.
 */
export function computePercentiles(
  rankedBestFirst: Pick<AuthorEngagement, "authorHandle" | "avgEngagement">[],
): Map<string, number> {
  const n = rankedBestFirst.length;
  const out = new Map<string, number>();
  for (let first = 0; first < n; ) {
    let last = first;
    while (
      last + 1 < n &&
      rankedBestFirst[last + 1]!.avgEngagement === rankedBestFirst[first]!.avgEngagement
    ) {
      last++;
    }
    const pct = n <= 1 ? 1 : (n - 1 - (first + last) / 2) / (n - 1);
    for (let i = first; i <= last; i++) {
      out.set(rankedBestFirst[i]!.authorHandle, Number(pct.toFixed(4)));
    }
    first = last + 1;
  }
  return out;
}

export const PlaybookOutputSchema = z.object({
  hook_patterns: z.array(z.string()).max(8).default([]),
  structure_notes: z.string().default(""),
  cadence_notes: z.string().default(""),
  top_topics: z.array(z.string()).max(12).default([]),
});
export type PlaybookOutput = z.infer<typeof PlaybookOutputSchema>;

export function buildAnalystSystem(): string {
  return [
    "You are an engagement analyst for an X (Twitter) growth operator. You are given",
    "a single X creator and a bounded observed sample of saved posts (sorted by",
    "likes + replies + reposts). Describe recurring hooks, structure and topics so",
    "the operator can explore the structure for their own posts — never copy wording.",
    "These counts do not establish why a post gained reach. Exposure, audience and",
    "capture age are not controlled. Sparse samples are observations, not winners;",
    "do not infer posting cadence from a selected subset of saved posts.",
    "",
    "Output STRICT JSON, first char `{`, last char `}`, with exactly these keys:",
    '  "hook_patterns":  string[]  — up to 6 reusable opening-line patterns this',
    "                                person uses (e.g. \"contrarian one-liner\",",
    '                                "number + bold claim", "short personal confession").',
    '  "structure_notes": string   — how their posts are built (length, line breaks,',
    "                                lists, single-idea vs multi-beat, CTA style).",
    '  "cadence_notes":   string   — topics/angles repeated in the supplied content;',
    "                                no inferred posting schedule.",
    '  "top_topics":      string[] — up to 8 recurring themes in the observed sample.',
    "",
    "Be concrete and specific to THIS person. No preamble, no markdown fences.",
  ].join("\n");
}

export function renderAnalystPrompt(author: AuthorEngagement): string {
  const who = author.authorName ?? author.authorHandle;
  const headline = author.authorHeadline ? ` — ${author.authorHeadline}` : "";
  const posts = author.samplePosts
    .map(
      (p, i) =>
        `[${i + 1}] (${p.likes} likes, ${p.replies} replies, ${p.reposts} reposts) ${(p.text ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 800)}`,
    )
    .join("\n");
  return [
    `Creator: ${who}${headline} (x.com/${author.authorHandle})`,
    `Posts analyzed: ${author.postCount} measured of ${author.observedPostCount} recent saved posts; bounded observed sample (up to ${SAVED_POSTS_PER_AUTHOR} posts).`,
    `Average likes + replies + reposts among complete measured posts: ${Math.round(author.avgEngagement)}.`,
    "",
    "Observed posts with complete measurements (highest captured engagement first):",
    posts,
    "",
    "Output the strict JSON playbook object specified in the system prompt.",
  ].join("\n");
}

/** Tolerant JSON parse: raw, fenced, or first-brace-to-last-brace. */
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

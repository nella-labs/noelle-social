import { z } from "zod";

// Engagement Analyst — pure logic (ranking, percentiles, prompt, parse).
//
// The Intelligence box's third component. It reads the REAL engagement already
// captured on watchlist people's posts (noelle.leads payload.reactions /
// .comments) and distills the top performers into a reusable playbook: the hook
// patterns, post structure, length, cadence and topics that over-perform for
// that person. Feeds the Posts ideation worker (top-performer teardown) and the
// post-drafter (hook patterns).
//
// This module is deliberately side-effect-free so the ranking + parsing is
// unit-testable without a DB or an LLM. The DB reads/writes live in
// leads-engagement-db.ts / playbooks-db.ts and the orchestration in
// workers/analyst-tick.ts.

export interface SamplePost {
  externalId: string;
  text: string | null;
  url: string | null;
  reactions: number;
  comments: number;
}

export interface AuthorEngagement {
  authorHandle: string;
  authorId: string | null;
  authorName: string | null;
  authorHeadline: string | null;
  postCount: number;
  avgEngagement: number;
  totalEngagement: number;
  samplePosts: SamplePost[];
}

/**
 * Percentile (0-1) for each author by their rank in the engagement-sorted list.
 * Top performer → 1, bottom → 0. A single author is treated as the top (1).
 * Input MUST already be sorted best-first (as getWatchlistAuthorEngagement
 * returns it). Keyed by authorHandle.
 */
export function computePercentiles(
  rankedBestFirst: Pick<AuthorEngagement, "authorHandle">[],
): Map<string, number> {
  const n = rankedBestFirst.length;
  const out = new Map<string, number>();
  rankedBestFirst.forEach((a, i) => {
    const pct = n <= 1 ? 1 : (n - 1 - i) / (n - 1);
    out.set(a.authorHandle, Number(pct.toFixed(4)));
  });
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
    "You are an engagement analyst for a LinkedIn growth operator. You are given a",
    "single LinkedIn creator and a sample of their best-performing posts (sorted by",
    "reactions + comments). Reverse-engineer WHY these posts work so the operator",
    "can borrow the structure for their own posts — never to copy wording.",
    "",
    "Output STRICT JSON, first char `{`, last char `}`, with exactly these keys:",
    '  "hook_patterns":  string[]  — up to 6 reusable opening-line patterns this',
    "                                person uses (e.g. \"contrarian one-liner\",",
    '                                "number + bold claim", "short personal confession").',
    '  "structure_notes": string   — how their posts are built (length, line breaks,',
    "                                lists, single-idea vs multi-beat, CTA style).",
    '  "cadence_notes":   string   — topics/angles they return to, posting rhythm if',
    "                                visible.",
    '  "top_topics":      string[] — up to 8 themes that over-perform for them.',
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
        `[${i + 1}] (${p.reactions} reactions, ${p.comments} comments) ${(p.text ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 800)}`,
    )
    .join("\n");
  return [
    `Creator: ${who}${headline} (linkedin.com/in/${author.authorHandle})`,
    `Posts analyzed: ${author.postCount}, avg engagement ${Math.round(author.avgEngagement)}.`,
    "",
    "Best-performing posts (highest engagement first):",
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

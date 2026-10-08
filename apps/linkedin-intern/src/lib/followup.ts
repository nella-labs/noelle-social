import { z } from "zod";
import type { ModelRouting } from "@noelle/runtime";
import { ANTI_AI_RULES, scoreFormat, stripDisallowedEmoji, WRITING_STRUCTURE_GUIDANCE } from "@noelle/runtime";
import { stripEmDashes } from "@noelle/runtime/voice-sanitize";
import type { CodexRunner } from "./codex-runner.js";

// Connection Follow-up (Lyra) — the operator names a person they JUST connected
// with; Lyra scrapes that person's recent posts + authored comments (via the same
// Apify actors the profiler uses) and generates a *connection brief*: common
// ground, talking points, a list of genuine questions, and a warm follow-up DM.
//
// The point is a GENUINE relationship, not outreach: no pitch, no product, no
// link. Draft-only, like everything Lyra does. This module is the pure logic
// (prompt + schema + anti-slop scrub + the one LLM call), kept separate from the
// worker entrypoint (workers/followup.ts) so it's unit-testable with a fake
// runner. Mirrors lib/vip-dm.ts in spirit.

// The shared runtime honors NOELLE_CODEX_PRIMARY before this configured route.
// Its organization/backend settings can also rewrite the Bedrock primary to
// Claude CLI; these handles alone do not identify the model that executes.
const OPUS_MODEL = "claude-opus-4-6";
export const FOLLOWUP_ROUTING: ModelRouting = {
  primary: { engine: "bedrock", model: OPUS_MODEL },
  fallback: { engine: "bedrock", model: OPUS_MODEL },
};

/** One of the target person's recent posts (from Apify profilePosts). */
export interface FollowupPost {
  text: string;
  postedAt?: string | null;
  reactions?: number | null;
  comments?: number | null;
}

/** Who we're building a connection with. */
export interface FollowupPerson {
  name: string | null;
  headline: string | null;
  publicId: string | null;
}

/** The generated connection brief (the deliverable printed to the operator). */
export interface ConnectionBrief {
  person: FollowupPerson;
  /** Real shared ground / why this connection is worth investing in. */
  commonGround: string[];
  /** Specific, concrete things from their work worth referencing. */
  talkingPoints: string[];
  /** The list of genuine, grounded questions to open a real conversation. */
  questions: string[];
  /** A warm, no-pitch follow-up DM, already scrubbed of em-dashes + slop. */
  followupDm: string;
  /** Which model produced it (for the operator's awareness). */
  model: string;
}

const SYSTEM_FOLLOWUP = [
  WRITING_STRUCTURE_GUIDANCE,
  ANTI_AI_RULES,
  "You are helping the operator build a GENUINE relationship with someone they JUST connected with on LinkedIn. This is relationship-building, NOT selling.",
  "You are given the person's identity, their recent posts, the comments they wrote on other people's posts, and (when available) a prior profile summary. Ground EVERYTHING you output ONLY in that material. Never invent facts, shared history, or experiences that are not supplied.",
  "Produce a connection brief with four parts:",
  "1. common_ground: 1-4 short bullets on real shared ground or why this person is genuinely worth knowing, drawn from their actual work. If the signal is thin, return fewer. Never pad.",
  "2. talking_points: 2-6 specific, concrete things from THEIR posts/comments worth referencing (name the actual detail or claim, not a vague theme).",
  "3. questions: 3-8 genuine, curious questions a real peer would actually ask — specific to what they wrote, open-ended, never rhetorical, never generic ('what got you into X?'). These are the point: they should open a real conversation and help the operator connect authentically.",
  "4. followup_dm: ONE short, warm, first-person DM to send now that they're connected. Reference one specific thing from their work, then ask one genuine question. No pitch, no product, no link, no CTA. Under ~600 characters.",
  "Voice for the DM: plain, warm, direct, the way a real person types a message. Contractions. A curious peer learning from them, not a fan, not an authority.",
  "NEVER use an em-dash. NEVER open with 'Curious:', 'Love this', 'I love how', 'This resonates', or 'Hey ,'. NEVER close with 'Would love to hear', 'Would love to connect', 'Keen to hear', or 'Let me know'. NEVER use negative parallelism ('not X, it's Y'). NEVER use buzzwords (leverage, unlock, resonate, journey, space, align, synergy, dive).",
  'Output ONLY strict JSON: {"common_ground":[...],"talking_points":[...],"questions":[...],"followup_dm":"..."}. First character {, last character }.',
].join(" ");

// Element typing is deliberately lenient: a stray empty/whitespace bullet from
// the model must NOT reject the whole brief (element-level `.min(1)` would fail
// the whole array -> the whole object). Blanks are trimmed + dropped and the max
// bounds + the "at least one question" rule are applied after cleaning, in
// buildConnectionBrief (via cleanList).
const FollowupOutput = z.object({
  common_ground: z.array(z.string()).default([]),
  talking_points: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
  followup_dm: z.string().min(1),
});

// Phrase-level tells that make a DM read as AI (mirrors lib/vip-dm.ts). The
// em-dash scrub is deterministic; these catch the openers/closers/buzzwords the
// prompt bans and trigger ONE plainer regeneration of the whole brief.
const DM_TELLS: RegExp[] = [
  /\bcurious[:,]/i,
  /\blove this\b/i,
  /\bthis resonates\b/i,
  /\bi love how\b/i,
  /\bwould love to (hear|connect)\b/i,
  /\bkeen to hear\b/i,
  /\blet me know\b/i,
  /\b(leverage|unlock|synergy)\b/i,
  /\b(journey|align|dive)\b/i,
  /\bresonate(d|s)?\b/i,
  // negative parallelism: "not just X, it's Y" AND "it's not X, it's Y"
  /\bnot just\b[^.?!]{0,40}\bit'?s\b/i,
  /\bit'?s not\b[^.?!]{0,40},?\s*it'?s\b/i,
];

/** The deterministic voice backstop applied to EVERY shipped line — the DM AND
 *  the questions/talking points/common ground. voice-sanitize's own rationale is
 *  that the model emits em-dashes even when told not to, so a post-pass is the
 *  only guarantee; the questions are what the operator pastes into LinkedIn, so
 *  the #1 tell (em-dash) must be stripped there too, not just in the DM. */
function scrubText(s: string): string {
  return stripDisallowedEmoji(stripEmDashes(s ?? "")).trim();
}

/** Trim + scrub each entry, drop blanks, and cap the count. A stray empty bullet
 *  is pruned rather than rejecting the whole brief (the schema is lenient). */
function cleanList(arr: string[], max: number): string[] {
  const out: string[] = [];
  for (const raw of arr) {
    const s = scrubText(raw);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Trim, unwrap an obvious "Here's a DM:" instruction wrapper + surrounding
 * quotes, strip em-dashes + disallowed emoji. Keeps intended line breaks (a
 * follow-up DM may breathe across a couple of lines) but collapses blank-line
 * runs. The preamble strip requires a wrapper NOUN (dm/message/draft/note/…)
 * before the colon, so a genuine warm opener like "Here's what stuck with me:"
 * is NOT eaten; quotes are stripped only when the whole DM is a wrapped pair.
 */
export function scrubFollowupDm(raw: string): string {
  let t = (raw ?? "").trim();
  t = t
    .replace(/^(here'?s|here is)\b[^:]{0,30}\b(dm|message|draft|note|reply|intro)\b[^:]{0,15}:\s*/i, "")
    .trim();
  if (/^["'“”][\s\S]*["'“”]$/.test(t)) {
    t = t.replace(/^["'“”]+/, "").replace(/["'“”]+$/, "").trim();
  }
  t = scrubText(t);
  // Collapse 3+ newlines to a paragraph break; trim trailing space per line.
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function looksAi(text: string): boolean {
  return DM_TELLS.some((re) => re.test(text));
}

function renderFollowupPrompt(args: {
  person: FollowupPerson;
  posts: FollowupPost[];
  comments: string[];
  existingSummary?: string | null;
  objective?: string | null;
}): string {
  const who = args.person.name ?? args.person.publicId ?? "this person";
  const lines: string[] = [
    `You just connected with: ${who}${args.person.publicId ? ` (linkedin.com/in/${args.person.publicId})` : ""}`,
  ];
  if (args.person.headline) lines.push(`Their headline: ${args.person.headline}`);
  if (args.existingSummary?.trim()) {
    lines.push("", "Prior profile summary (from Lyra):", args.existingSummary.trim());
  }
  if (args.objective?.trim()) {
    lines.push("", `Operator's angle with this person: ${args.objective.trim()}`);
  }
  if (args.posts.length > 0) {
    lines.push("", `Their recent posts (${args.posts.length}, newest first):`);
    args.posts.forEach((p, i) => {
      lines.push(`[${i + 1}] ${p.text.replace(/\s+/g, " ").trim()}`);
    });
  }
  if (args.comments.length > 0) {
    lines.push(
      "",
      `Comments they wrote on other people's posts (${args.comments.length}) — their outbound voice / what they engage with:`,
    );
    args.comments.forEach((c, i) => {
      lines.push(`(${i + 1}) ${c.replace(/\s+/g, " ").trim()}`);
    });
  }
  lines.push(
    "",
    "Output the strict JSON connection brief specified in the system prompt. First char `{`, last char `}`.",
  );
  return lines.join("\n");
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  try {
    const stripped = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    return JSON.parse(stripped);
  } catch {
    /* fall through */

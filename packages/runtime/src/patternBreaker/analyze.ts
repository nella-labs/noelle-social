// Pattern Breaker — core analyzer.
//
// The cross-post sibling of draftVerifier. The verifier grades ONE draft against
// a hardcoded slop list; this reads the operator's last N posts as a CORPUS and
// finds STRUCTURAL habits that repeat too often, then emits anti-pattern rules
// the drafter + verifier consume dynamically.
//
// Pure + offline-testable: the LLM is injected as a closure (mirrors the
// verifier's VerifierCall). The worker wires the model/routing/budget.

import {
  PatternAnalysisSchema,
  PatternFindingSchema,
  type PatternExample,
  type PatternFinding,
} from "@noelle/contracts";
import { compileLearnedPattern, type LearnedPattern } from "./regex.js";

/** One post in the analysis corpus, newest-first. */
export interface PatternPost {
  draftId: string;
  body: string;
  kind: "reply" | "post";
}

/** Injected LLM: (system, prompt) → raw model text. */
export type PatternAnalyzerCall = (system: string, prompt: string) => Promise<string>;

export interface AnalyzePatternsArgs {
  /** Corpus newest-first (most recent post at index 0), up to ~100. */
  posts: PatternPost[];
  /** Window sizes to evaluate phrase frequency at. Default 10/20/30/40/50/100. */
  windows?: number[];
  /** Active rule labels to dedup against — the LLM is told NOT to re-report these. */
  existingLabels?: string[];
  /** Minimum matches within a window to flag a pattern. Default 3. */
  minFrequency?: number;
  /** Minimum share of a window (0..1) for a phrase to count as "too much". Default 0.3. */
  minRatio?: number;
  call: PatternAnalyzerCall;
}

export interface AnalyzedPattern {
  finding: PatternFinding;
  /** The tightest window in which the pattern is over-represented. */
  windowSize: number;
}

export const DEFAULT_WINDOWS = [10, 20, 30, 40, 50, 100];

const ANALYZER_SYSTEM = [
  "You are a brutally honest editor auditing an operator's recent social posts for REPETITION.",
  "You are given the operator's most recent posts, newest first. Your job: find STRUCTURAL patterns the operator over-uses — habits that make the posts feel templated when read back to back.",
  "Look for things like:",
  "- A repeated OPENER (every post starts with a one-line hook then a blank line).",
  "- A repeated CLOSER (a long paragraph followed by a tiny phrase like 'congrats' or 'big if true').",
  "- A repeated RHYTHM (choppy one-sentence-per-line staccato; the 'X. Then Y. Then Z.' three-beat).",
  "- A repeated FRAME ('the gap between X and Y', 'most people think… but actually…').",
  "- A specific PHRASE or transition word that shows up far too often.",
  "Do NOT report things that appear only once or twice — only genuinely OVER-USED patterns. Quality variation is good; flag SAMENESS.",
  "A pattern only counts as over-used if it shows up in a SUBSTANTIAL share of the posts — roughly a third or more — not just a handful. A tic in 5 of 100 posts is normal human variation; do NOT flag it. Be conservative: when in doubt, leave it out.",
  "For each pattern classify kind:",
  "- 'phrase' when it can be caught by a regular expression (a literal phrase, a recurring word, a punctuation tic). Provide a case-insensitive JS `regex` (no leading/trailing slashes, no flags) that matches the offending text.",
  "- 'structure' when it is a shape a regex cannot express (an opener/closer/rhythm). Set `regex` to null.",
  "`instruction` is the single NEVER-DO line to hand the drafter (imperative, specific, e.g. \"Do not end a substantive post with a tacked-on tiny phrase like 'congrats' or 'big if true'; end on the actual point.\").",
  "`suggestion` is the POSITIVE mirror of `instruction`: one short imperative line telling the writer what to do INSTEAD (e.g. \"End on the sharpest concrete point and let it stand — no tacked-on reaction phrase.\"). Concrete and specific to THIS habit, not generic advice. The operator sees it as \"TRY INSTEAD\" and the drafter is steered by it.",
  "For structure findings, include supporting evidence for every counted distinct post in `evidence` (up to 100 items): each item must have numeric `sourceIndex` from the [#] shown and a non-empty exact snippet copied from that post. Semantic structure matching is your judgment; the evidence makes that judgment reviewable.",
  "Distinguish repeated meaning or repeated ending function from mere punctuation. Offer a scoped positive revision that fits the source posts; do not enforce provider stereotypes or fiction techniques.",
  "`description` is one plain sentence telling the operator what they keep doing and roughly how often.",
  "`frequencyCount` is how many of the provided posts exhibit it. `examples` is up to 3 short snippets (<=200 chars) copied from the posts, each with the post's index as `draftId` (use the [#] number shown). For structure findings, `evidence` must cover every counted post, not only display examples.",
  "Output STRICT JSON, no markdown fences, no preamble. First char `{`, last `}`:",
  '  {"findings":[{"label":"…","kind":"phrase|structure","description":"…","instruction":"…","suggestion":"…","regex":"…"|null,"severity":"low|medium|high","frequencyCount":N,"examples":[{"draftId":"3","snippet":"…"}],"evidence":[{"sourceIndex":3,"snippet":"…"}]}]}',
  "Return at most 8 findings, strongest first. If nothing is genuinely over-used, return {\"findings\":[]}.",
].join("\n");

function renderAnalyzerPrompt(posts: PatternPost[], existingLabels: string[]): string {
  const parts: string[] = [];
  parts.push(`BOUNDED OBSERVED SAMPLE: ${posts.length} admitted recent posts (newest first):`);
  posts.forEach((p, i) => {
    parts.push(`[${i}] (${p.kind}) ${p.body.replace(/\s+/g, " ").trim()}`);
  });
  if (existingLabels.length) {
    parts.push(
      "",
      "ALREADY-FLAGGED PATTERNS (do NOT report these again — they are already being broken):",
      ...existingLabels.map((l) => `- ${l}`),
    );
  }
  parts.push("", "Find the OVER-USED structural patterns. Output the strict JSON only.");
  return parts.join("\n");
}

/** Tolerant JSON extraction, mirrors the verifier's parseJudge. */
function extractJson(text: string): unknown {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let obj = tryParse(text.trim());
  if (obj === undefined) {
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    obj = tryParse(stripped.trim());
  }
  if (obj === undefined) {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a >= 0 && b > a) obj = tryParse(text.slice(a, b + 1));
  }
  return obj;
}

function compiles(src: string): boolean {
  return compileLearnedPattern(src) !== null;
}

function normalizeLabel(s: string): string {
  return s.trim().toLowerCase();
}

function normalizeSnippet(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function boundedPhraseSnippet(body: string, re: LearnedPattern, fallback: string): string {
  const match = re.match(body) ?? fallback;
  return match.slice(0, 600);
}

function verifiedStructureEvidence(finding: PatternFinding, posts: PatternPost[]): PatternExample[] {
  const seenSourceIndexes = new Set<number>();
  const seenDraftIds = new Set<string>();
  const verified: PatternExample[] = [];
  for (const evidence of finding.evidence ?? []) {
    const index = evidence.sourceIndex;
    const post = posts[index];
    if (!post || seenSourceIndexes.has(index) || seenDraftIds.has(post.draftId)) continue;
    const snippet = normalizeSnippet(evidence.snippet);
    if (!snippet) continue;
    if (!normalizeSnippet(post.body).includes(snippet)) continue;
    seenSourceIndexes.add(index);
    seenDraftIds.add(post.draftId);
    verified.push({ draftId: post.draftId, snippet });
  }
  return verified;
}

function chooseWindowForEvidence(
  evidence: PatternExample[],
  posts: PatternPost[],
  windows: number[],
  minFrequency: number,
  minRatio: number,
): { window: number; matches: PatternExample[] } | null {
  const byDraftId = new Map(evidence.map((example) => [example.draftId, example]));
  const corpusSize = posts.length;
  for (const w of windows) {
    const window = Math.min(w, corpusSize);
    const seenDraftIds = new Set<string>();
    const matches: PatternExample[] = [];
    for (const post of posts.slice(0, window)) {
      if (seenDraftIds.has(post.draftId)) continue;
      seenDraftIds.add(post.draftId);
      const example = byDraftId.get(post.draftId);
      if (example) matches.push(example);
    }
    if (matches.length >= minFrequency && matches.length / window >= minRatio) {
      return { window, matches };
    }
  }
  return null;
}

/**
 * Analyze the corpus and return the over-used patterns worth breaking.
 *
 * Hybrid: the LLM proposes findings; for 'phrase' findings with a compilable
 * regex we RECOUNT matches deterministically across each window (10/20/.../100)
 * and keep the tightest window where the phrase clears both the count and ratio
 * floors — so "over-used" is grounded in the real corpus, not the model's guess.
 * 'structure' findings can't be regex-counted, so the LLM must provide exact
 * source evidence. We verify that evidence against the corpus and recompute the
 * count/window from distinct matched posts.
 */
export async function analyzePatterns(args: AnalyzePatternsArgs): Promise<AnalyzedPattern[]> {
  const {
    posts,
    windows = DEFAULT_WINDOWS,
    existingLabels = [],
    minFrequency = 3,
    minRatio = 0.3,
    call,
  } = args;

  if (posts.length === 0) return [];

  const seenLabels = new Set(existingLabels.map(normalizeLabel));
  const sortedWindows = [...windows].sort((a, b) => a - b);
  const corpusSize = posts.length;

  let raw: string;
  try {
    raw = await call(ANALYZER_SYSTEM, renderAnalyzerPrompt(posts, existingLabels));
  } catch {
    return [];
  }

  const parsed = PatternAnalysisSchema.safeParse(extractJson(raw));
  if (!parsed.success) return [];

  const out: AnalyzedPattern[] = [];
  for (const finding of parsed.data.findings) {
    const label = normalizeLabel(finding.label);
    if (seenLabels.has(label)) continue; // dedup vs active rules AND within this batch
    seenLabels.add(label);

    // Drop a phrase finding whose regex doesn't compile — degrade it to structure
    // so a malformed pattern never reaches the DB as a deterministic rule.
    let normalized: PatternFinding = finding;
    if (finding.kind === "phrase" && (!finding.regex || !compiles(finding.regex))) {
      normalized = { ...finding, kind: "structure", regex: null };
    }

    if (normalized.kind === "phrase" && normalized.regex) {
      // Deterministic recount: find the tightest window where it's over-represented.
      const re = compileLearnedPattern(normalized.regex);
      if (!re) continue;
      let chosen: { window: number; matches: PatternPost[] } | null = null;
      for (const w of sortedWindows) {
        const slice = posts.slice(0, Math.min(w, corpusSize));
        const matches = slice.filter((p) => re.test(p.body));
        if (matches.length >= minFrequency && matches.length / slice.length >= minRatio) {
          chosen = { window: Math.min(w, corpusSize), matches };
          break;
        }
      }
      if (!chosen) continue; // not actually over-used in any window — skip
      out.push({
        finding: {
          ...normalized,
          frequencyCount: chosen.matches.length,
          examples: chosen.matches.slice(0, 6).map((post) => ({
            draftId: post.draftId,
            snippet: boundedPhraseSnippet(post.body, re, normalized.regex!),
          })),
        },
        windowSize: chosen.window,
      });
    } else {
      const evidence = verifiedStructureEvidence(normalized, posts);
      const chosen = chooseWindowForEvidence(evidence, posts, sortedWindows, minFrequency, minRatio);
      if (!chosen) continue;
      out.push({
        finding: {
          ...normalized,
          frequencyCount: chosen.matches.length,
          examples: chosen.matches.slice(0, 6),
        },
        windowSize: chosen.window,
      });
    }
  }
  return out;
}

// ---- Refine ---------------------------------------------------------------
// "Refine with AI": the operator hit Refine on an alert (optionally with a
// steer). Rewrite the rule's NEVER-DO instruction so it's sharper / scoped the
// way the operator wants. Pure + LLM-injected, like analyzePatterns.

export interface RefineRuleArgs {
  /** The rule's current instruction (what the drafter is told to avoid). */
  currentInstruction: string;
  /** The plain-English description of the habit (for context). */
  description: string;
  /** Example offending snippets (for context). */
  examples?: PatternExample[];
  /** The operator's optional steer ("only when it's a genuine congrats"). */
  note?: string | null;
  call: PatternAnalyzerCall;
}

const REFINE_SYSTEM = [
  "You refine a single anti-pattern rule for an operator's social-post drafter.",
  "You are given the rule's current NEVER-DO instruction, a description of the habit, example offending snippets, and an optional steer from the operator.",
  "Rewrite the instruction so it is sharper and more useful to the drafter: imperative, specific, one or two sentences, no preamble.",
  "If the operator's steer narrows or changes the rule (e.g. 'this is fine when it's a genuine congrats'), honor it exactly.",
  "Do NOT widen the rule into a blanket ban that would hurt good writing. Keep it about the SPECIFIC over-used habit.",
  "Output STRICT JSON, no markdown fences, no preamble. First char `{`, last `}`:",
  '  {"instruction":"…"}',
].join("\n");

function renderRefinePrompt(args: RefineRuleArgs): string {
  const parts: string[] = [];
  parts.push("CURRENT INSTRUCTION:", args.currentInstruction);
  parts.push("", "HABIT DESCRIPTION:", args.description);
  if (args.examples?.length) {
    parts.push("", "EXAMPLE OFFENDING SNIPPETS:");
    parts.push(...args.examples.slice(0, 4).map((e, i) => `[${i + 1}] ${e.snippet}`));
  }
  if (args.note?.trim()) {
    parts.push("", "OPERATOR STEER (honor this):", args.note.trim());
  }
  parts.push("", "Rewrite the instruction. Output the strict JSON only.");
  return parts.join("\n");
}

/**
 * Rewrite a rule instruction with AI. Returns the new instruction, or null if
 * the model output was unusable (caller keeps the current instruction).
 */
export async function refineRule(args: RefineRuleArgs): Promise<string | null> {
  let raw: string;
  try {
    raw = await args.call(REFINE_SYSTEM, renderRefinePrompt(args));
  } catch {
    return null;
  }
  const obj = extractJson(raw);
  if (!obj || typeof obj !== "object") return null;
  const instruction = (obj as Record<string, unknown>).instruction;
  if (typeof instruction !== "string") return null;
  const trimmed = instruction.trim();
  const admitted = PatternFindingSchema.shape.instruction.safeParse(trimmed);
  return admitted.success ? admitted.data : null;
}

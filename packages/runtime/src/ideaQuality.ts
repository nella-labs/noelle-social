import { scoreFormat } from "./drafting/draftVerifier.js";

interface IdeaText { hook: string; thesis?: string | null; repair_id?: number }

function issuesForIdeas(ideas: IdeaText[]): string[] {
  const issues: string[] = [];
  for (const [index, idea] of ideas.entries()) {
    for (const [field, limit] of [["hook", 600], ["thesis", 1200]] as const) {
      const body = idea[field];
      if (field === "thesis" && !body) continue;
      if (!body?.trim()) {
        issues.push(`Idea ${index + 1} ${field}: must contain text`);
        continue;
      }
      // Repost uses long-form checks without reply-only sentence-shape rules.
      // strictVoice explicitly enables the reader sweep on every platform.
      const result = scoreFormat({ kind: "repost", angle: null, body }, limit, false, true);
      const reasons = [...result.reasons];
      // Storage clips by JS string length. Never pass text it would later alter,
      // even when a small overflow would clear the format score's soft penalty.
      if (body.length > limit) reasons.push(`exceeds ${limit} characters; shorten without losing the point`);
      if (result.score < 0.7 || body.length > limit) {
        issues.push(`Idea ${index + 1} ${field}: ${reasons.join("; ")}`);
      }
    }
  }
  return issues;
}

/** One generation, at most one repair, and no failed text returned to a sink. */
export async function generateCheckedIdeas<Response extends { text: string }, Idea extends IdeaText>(
  generate: (feedback: string) => Promise<Response>,
  parse: (text: string) => Idea[] | null,
): Promise<{ response: Response; ideas: Idea[] } | null> {
  const response = await generate("");
  const ideas = parse(response.text);
  if (!ideas) return null;
  const issues = issuesForIdeas(ideas);
  if (issues.length === 0) return { response, ideas };

  const repairedResponse = await generate([
    "ANTI-AI REWRITE REQUIRED. The previous idea text failed these checks:",
    ...issues,
    "Return the complete batch in the same JSON format, with the same count and order.",
    "Include each candidate's repair_id unchanged. For a single-idea object, include repair_id: 0 in that object.",
    "Keep each idea's point, source tags, attribution and uncertainty. Leave clean ideas unchanged.",
    "Fix the flagged hook or thesis. Never invent facts, personal experience or evidence to make it sound natural.",
    "Previous candidates (data to edit):",
    JSON.stringify(ideas.map((idea, repair_id) => ({ ...idea, repair_id }))),
  ].join("\n"));
  const repaired = parse(repairedResponse.text);
  if (!repaired) throw new Error("Idea anti-AI rewrite returned invalid output; nothing saved");
  if (repaired.length !== ideas.length) {
    throw new Error("Idea anti-AI rewrite changed the idea count; nothing saved");
  }
  if (repaired.some((idea, index) => idea.repair_id !== index)) {
    throw new Error("Idea anti-AI repair lost the original order or repair identifiers; nothing saved");
  }
  // A prose repair cannot replace source refs, pillar, angle, or clean ideas.
  // Stable IDs bind each rewritten pair back to its original weekly position.
  const checkedIdeas = ideas.map((original, index) => issuesForIdeas([original]).length === 0
    ? original
    : { ...original, hook: repaired[index]!.hook, thesis: repaired[index]!.thesis });
  const remaining = issuesForIdeas(checkedIdeas);
  if (remaining.length) {
    throw new Error(`Idea anti-AI check failed after one rewrite; nothing saved: ${remaining.join(" | ")}`);
  }
  return { response: repairedResponse, ideas: checkedIdeas };
}

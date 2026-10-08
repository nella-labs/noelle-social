import { IDEA_WRITING_GUIDANCE, WRITING_STRUCTURE_GUIDANCE } from "@noelle/runtime";
import { z } from "zod";
import { loadVoiceSpec, voiceSpecBlock } from "./voice-spec.js";

// Idea-level "polish" — pure logic (system, prompt, parse), side-effect-free so
// it's unit-testable without an LLM. The worker (polish-tick.ts) loads the idea
// + voice anchors, calls the model, and writes the refined hook/thesis back.
//
// Polish SHARPENS an existing idea — it keeps the same core point and angle, and
// must NOT fabricate (same hard ban as the drafter). It reads the operator's
// vault voice-spec so the refined idea matches their voice.

export interface PolishIdeaInput {
  hook: string;
  thesis: string | null;
  angle: string | null;
  pillar: string | null;
}

export const PolishSchema = z.object({
  repair_id: z.number().int().nonnegative().optional(),
  hook: z.string().min(1).max(600),
  thesis: z.string().max(1200).nullable().default(null),
});
export type PolishResult = z.infer<typeof PolishSchema>;

export function buildPolishSystem(objective: string | null, brandBlock?: string | null): string {
  const spec = loadVoiceSpec();
  return [
    WRITING_STRUCTURE_GUIDANCE,
    IDEA_WRITING_GUIDANCE,
    "You refine a single content IDEA in a specific operator's voice. You are NOT",
    "writing the final post — you sharpen the IDEA: a stronger hook and a tighter",
    "thesis the drafter will later turn into posts.",
    voiceSpecBlock(spec),
    brandBlock ? `\n${brandBlock}\n` : "",
    objective ? `\nOperator objective: ${objective}\n` : "",
    "",
    "KEEP the same core point and angle — do not change the topic. Make it:",
    "  - a hook that is specific and concrete (a real number, moment, or stake),",
    "    creates tension in the first 8 words, no throat-clearing;",
    "  - a thesis that is one clear, arguable point (not a summary).",
    "",
    "NEVER fabricate the operator's history or add facts/anecdotes absent from the source idea.",
    "Preserve qualifications, attribution and uncertainty. No em dashes (use commas, periods, or parentheses). No AI-slop",
    "phrases ('hits different', 'the gap between…', 'curious to hear…').",
    "",
    "Output STRICT JSON, first char `{`, last char `}`:",
    '{ "hook": string,            // the sharpened hook',
    '  "thesis": string|null }    // the tightened thesis (null if the idea has none)',
    "No preamble, no markdown fences.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderPolishPrompt(idea: PolishIdeaInput, voiceAnchors: string[]): string {
  const oneLine = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, " ").trim();
  return [
    "## The idea to refine",
    `Hook: ${idea.hook}`,
    idea.thesis ? `Thesis: ${idea.thesis}` : "Thesis: (none yet)",
    idea.angle ? `Angle: ${idea.angle}` : "",
    idea.pillar ? `Pillar: ${idea.pillar}` : "",
    "",
    voiceAnchors.length
      ? ["## Operator voice (match this tone)", ...voiceAnchors.map((a) => `- ${oneLine(a, 400)}`)].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Parse the model's JSON into a validated PolishResult, or null on any failure. */
export function parsePolish(text: string): PolishResult | null {
  let json: unknown;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = PolishSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

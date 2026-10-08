import { z } from "zod";
import { evaluateJevBoolean, isBudgetAdmissionError } from "@noelle/runtime";

// W1.5 objective grading — the Vega-style relevance filter for the niche/viral
// lane. A hashtag feed (even one Nova planned from the objective) carries
// off-topic clips; this asks the LLM which pulled clips actually serve the
// operator's objective and drops the rest, so the corpus Nova learns from stays
// on-brand. Pure prompt/parse helpers are unit-tested; the call is injected so
// the worker wires it to the Gemini seam. FAIL-OPEN by design: on a blank
// objective, an empty batch, or an unparseable reply we keep ALL clips — a flaky
// grader must never silently empty the harvest.

export interface GradeClip {
  id: string;
  caption: string;
  authorHandle: string;
}

export type JsonCaller = (system: string, user: string) => Promise<unknown | null>;

export function buildObjectiveGradeMessages(
  objective: string,
  clips: GradeClip[],
): { system: string; user: string } {
  const system = [
    "You are Nova, a short-form video growth strategist filtering a freshly-harvested batch of Reels/TikToks.",
    "Keep only the clips whose TOPIC/FORMAT is genuinely useful for the operator's objective — a clip Nova could learn a viral format from and apply on-brand.",
    "Drop clips that are off-topic, generic spam, or unrelated to the objective even if they're popular.",
    "When unsure about a clip, KEEP it (err toward inclusion).",
    'Respond ONLY with JSON: {"keep": ["<id>", ...]} listing the ids to keep. No prose.',
  ].join("\n");
  const list = clips
    .map((c) => `- id=${c.id} @${c.authorHandle}: ${c.caption.replace(/\s+/g, " ").slice(0, 240) || "(no caption)"}`)
    .join("\n");
  const user = `Objective:\n${objective.trim()}\n\nClips:\n${list}\n\nReturn the ids to keep.`;
  return { system, user };
}

const KeepSchema = z.object({ keep: z.array(z.string()) });

/**
 * Parse the grader reply into the set of clip ids to keep, intersected with the
 * batch's real ids. Returns null when the reply is unparseable (caller fails
 * open and keeps all); returns a (possibly empty) id list when the model gave a
 * valid verdict.
 */
export function parseObjectiveGrade(raw: unknown, clips: GradeClip[]): string[] | null {
  const parsed = KeepSchema.safeParse(raw);
  if (!parsed.success) return null;
  const valid = new Set(clips.map((c) => c.id));
  const keep = new Set<string>();
  for (const id of parsed.data.keep) if (valid.has(id)) keep.add(id);
  return [...keep];
}

/**
 * Grade a batch of clips against the objective, returning the kept subset (order
 * preserved). Fail-open: blank objective / empty batch / null call / unparseable
 * reply all return the full input unchanged. Denied admission propagates.
 */
export async function gradeClipsForObjective<T extends GradeClip>(
  objective: string,
  clips: T[],
  call: JsonCaller,
  evaluate: typeof evaluateJevBoolean = evaluateJevBoolean,
): Promise<T[]> {
  if (!objective.trim() || clips.length === 0) return clips;
  const decisions = await Promise.all(clips.map(async (clip) => {
    try {
      return await evaluate({
        state: `Objective: ${objective.trim()}\nPost by @${clip.authorHandle}: ${clip.caption.slice(0, 1200)}`,
        instructions: "Judge whether this short-form video is useful as an on-brand format or topic for the operator's objective.",
        criteria: {
          true: "The video's topic or format can genuinely inform an on-brand video for this objective.",
          false: "The video is unrelated, generic spam, or has no useful format for this objective.",
        },
      });
    } catch {
      return { kind: "unavailable" as const, provider: "jev" as const };
    }
  }));
  const unknown = clips.filter((_, i) => decisions[i]?.kind !== "confident");
  if (unknown.length === 0) return clips.filter((_, i) => decisions[i]?.kind === "confident" && decisions[i].pass);
  const { system, user } = buildObjectiveGradeMessages(objective, unknown);
  let raw: unknown | null;
  try {
    raw = await call(system, user);
  } catch (error) {
    if (isBudgetAdmissionError(error)) throw error;
    raw = null;
  }
  const keepIds = parseObjectiveGrade(raw, unknown);
  const legacyKeep = new Set(keepIds ?? unknown.map((c) => c.id));
  return clips.filter((c, i) => decisions[i]?.kind === "confident" ? decisions[i].pass : legacyKeep.has(c.id));
}

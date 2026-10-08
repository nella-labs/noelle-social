import { z } from "zod";
import { loadBedrockBackend } from "@/lib/agent-chat/bedrock-backend";

// Propose a Nova objective FROM the operator's own account — "pull from my
// Instagram and figure out what I'm about". Given their own-account Brand Guide
// (what their content does) + sample post captions + any vault brand context, it
// drafts a 1-2 sentence objective like Vega/Lyra's. The operator reviews/edits
// before it's saved (we never silently set it). Pure prompt/parse helpers are
// unit-tested; the LLM call is fail-open (returns null → caller surfaces "try again").

const SUGGEST_MODEL = "claude-sonnet-4-6";
export const OBJECTIVE_SUGGEST_MAX = 600;

export interface SuggestObjectiveInput {
  /** Operator's own-account Brand Guide summary (what their content does), if distilled. */
  accountProfile?: string | null;
  /** A few of the operator's own post captions, newest/top first. */
  captions: string[];
  /** Optional vault brand/voice snippets (who they are / what they sell). */
  brandContext?: string[];
}

export function buildSuggestMessages(input: SuggestObjectiveInput): { system: string; prompt: string } {
  const system = [
    "You are Nova, a short-form video growth strategist.",
    "From the operator's OWN account (what they actually post) and any brand context, write a concise OBJECTIVE for their short-form video growth — the mission Nova should plan + film toward.",
    "It should name their niche/topic, who it's for, and the growth goal, in the operator's own terms — grounded in what they ALREADY make, not a generic 'grow my brand'.",
    `Keep it 1-2 sentences, under ${OBJECTIVE_SUGGEST_MAX} characters. No preamble.`,
    'Respond ONLY with JSON: {"objective": "..."}. No prose.',
  ].join("\n");
  const parts = [
    input.accountProfile ? `What their content does (distilled):\n${input.accountProfile}` : "",
    input.captions.length ? `Recent posts (captions):\n${input.captions.map((c) => `- ${c.replace(/\s+/g, " ").slice(0, 200)}`).join("\n")}` : "",
    input.brandContext?.length ? `Brand context (from their vault):\n${input.brandContext.map((b) => `- ${b.replace(/\s+/g, " ").slice(0, 240)}`).join("\n")}` : "",
    "Write the objective now.",
  ].filter(Boolean);
  return { system, prompt: parts.join("\n\n") };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const s = trimmed.indexOf("{");
    const e = trimmed.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(trimmed.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

const SuggestSchema = z.object({ objective: z.string() });

/** Parse + clamp the model's objective. Returns null when unparseable/blank. */
export function parseSuggestedObjective(text: string): string | null {
  const parsed = SuggestSchema.safeParse(extractJson(text));
  if (!parsed.success) return null;
  const obj = parsed.data.objective.replace(/\s+/g, " ").trim();
  if (!obj) return null;
  return obj.slice(0, OBJECTIVE_SUGGEST_MAX);
}

export interface SuggestObjectiveDeps {
  call?: (args: { system: string; prompt: string; model: string }) => Promise<{ text: string }>;
}

/**
 * Draft an objective from the operator's own account. Fail-open: no signal
 * (no captions/profile/brand) or any model/parse failure yields null.
 */
export async function suggestObjectiveFromAccount(
  input: SuggestObjectiveInput,
  deps: SuggestObjectiveDeps = {},
): Promise<string | null> {
  if (!input.accountProfile && input.captions.length === 0 && !(input.brandContext?.length)) return null;
  const { system, prompt } = buildSuggestMessages(input);
  try {
    const call = deps.call ?? (await loadBedrockBackend(1024)).call;
    const res = await call({ system, prompt, model: SUGGEST_MODEL });
    return parseSuggestedObjective(res.text);
  } catch {
    return null;
  }
}

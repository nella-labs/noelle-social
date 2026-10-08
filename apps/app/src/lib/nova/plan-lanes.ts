import { z } from "zod";
import { loadBedrockBackend } from "@/lib/agent-chat/bedrock-backend";

// Nova's objective → niche-lane planner. The operator gives Nova an objective
// (like Lyra/Vega's ICP); this expands it into hashtag/keyword discovery lanes
// so Nova "pulls with the objective in mind" instead of the operator hand-typing
// #YC #AI #Founder. The lanes it returns SUPPLEMENT the manual ones (the action
// dedupes + inserts). Pure prompt/parse helpers are unit-tested; the LLM call is
// fail-open (returns [] so the caller surfaces "couldn't plan" rather than 500).

export const MAX_PLANNED_LANES = 12;
const PLANNER_MODEL = "claude-haiku-4-5";

/** Normalise a raw query to the lane form: no #, trimmed, single-spaced, lower. */
export function normalizeLaneQuery(raw: string): string {
  return raw
    .replace(/^#/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function buildLanePlannerMessages(
  objective: string,
  platform: "instagram" | "tiktok",
  existing: string[],
): { system: string; prompt: string } {
  const net = platform === "tiktok" ? "TikTok" : "Instagram";
  const system = [
    `You are Nova, a short-form video (${net} Reels/TikTok) growth strategist.`,
    "Given the operator's objective, propose hashtag/keyword DISCOVERY lanes — the topics whose newest top-performing videos Nova should study to learn viral formats that fit this objective.",
    "Rules:",
    `- Return 6–${MAX_PLANNED_LANES} lanes, ordered most→least relevant.`,
    "- Each lane is a single hashtag or short keyword phrase, WITHOUT a leading # and WITHOUT quotes.",
    "- Favour terms that actually have a busy short-form video feed (broad enough to return clips, specific enough to stay on-objective).",
    "- Mix audience/topic terms and format terms (e.g. a niche + a style like 'build in public' or 'founder story').",
    "- Do NOT repeat any lane the operator already has.",
    'Respond ONLY with JSON: {"queries": ["lane one", "lane two", ...]}. No prose.',
  ].join("\n");
  const prompt = [
    `Objective:\n${objective.trim()}`,
    existing.length ? `\nLanes the operator already has (do not repeat):\n${existing.map((e) => `- ${e}`).join("\n")}` : "",
    `\nPropose the ${net} discovery lanes now.`,
  ]
    .filter(Boolean)
    .join("\n");
  return { system, prompt };
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

const PlannedSchema = z.object({ queries: z.array(z.string()) });

/**
 * Parse the model's reply into clean, deduped lanes. Drops blanks, normalises,
 * removes anything already in `existing` (case-insensitive), de-dupes within the
 * batch, and caps at MAX_PLANNED_LANES. Returns [] on unparseable output.
 */
export function parsePlannedLanes(text: string, existing: string[]): string[] {
  const parsed = PlannedSchema.safeParse(extractJson(text));
  if (!parsed.success) return [];
  const have = new Set(existing.map(normalizeLaneQuery));
  const out: string[] = [];
  for (const raw of parsed.data.queries) {
    const q = normalizeLaneQuery(raw);
    if (!q || q.length > 60 || have.has(q)) continue;
    have.add(q);
    out.push(q);
    if (out.length >= MAX_PLANNED_LANES) break;
  }
  return out;
}

export interface PlanNicheLanesDeps {
  /** Override for tests — defaults to the shared Bedrock backend. */
  call?: (args: { system: string; prompt: string; model: string }) => Promise<{ text: string }>;
}

/**
 * Expand an objective into fresh niche lanes for `platform`, excluding `existing`.
 * Fail-open: any model/parse failure yields []. The caller decides what to do
 * with an empty result (surface "couldn't plan — try again").
 */
export async function planNicheLanes(
  objective: string,
  platform: "instagram" | "tiktok",
  existing: string[],
  deps: PlanNicheLanesDeps = {},
): Promise<string[]> {
  if (!objective.trim()) return [];
  const { system, prompt } = buildLanePlannerMessages(objective, platform, existing);
  try {
    const call = deps.call ?? (await loadBedrockBackend(1024)).call;
    const res = await call({ system, prompt, model: PLANNER_MODEL });
    return parsePlannedLanes(res.text, existing);
  } catch {
    return [];
  }
}

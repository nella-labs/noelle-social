import type { VideoScriptOutput } from "@noelle/contracts";
import { evaluateJevBoolean, isBudgetAdmissionError, scoreFormat, WRITING_STRUCTURE_GUIDANCE, type DynamicPattern } from "@noelle/runtime";
import type { JsonFn } from "./video-generate.js";

// Post-draft VERIFIER for Nova's scripts — the video sibling of the Lyra/Vega
// drafter's draftVerifier. Nova was built without it, so its scripts never got
// the four-dimension grade (voice / grounding / relevance / format) or a
// regenerate loop, and the studio's verifier-trace card had nothing to render.
//
// Format is DETERMINISTIC and REUSED verbatim from the shared drafter verifier
// (`scoreFormat`): em-dash hard-zero, named AI-slop tells, repeated/garbled text.
// voice / grounding / relevance come from an LLM judge tuned for a short-form
// VIDEO SCRIPT (not a reply to a post), injected as a JsonFn so this module is
// pure + offline-testable. An unavailable judge fails review; denied admission
// propagates. The deterministic format check still applies. Emits the SAME
// shape the studio's VerifierTraceCard reads:
//   { pass, scores:{voice,grounding,relevance,format}, reasons, attempts }.

export interface ScriptVerifyContext {
  objective: string | null;
  hook: string;
  concept: string | null;
  /** The operator's own brand/voice snippets (from the vault) the script must match. */
  voiceAnchors: readonly string[];
  /** Learned Pattern Breaker rules (over-used habits) to enforce, matching Lyra. */
  patternRules?: readonly DynamicPattern[];
}

export interface ScriptScores {
  voice: number;
  grounding: number;
  relevance: number;
  format: number;
}

export interface ScriptVerdict {
  pass: boolean;
  scores: ScriptScores;
  reasons: string[];
  /** Actionable critique appended to the scripter prompt on a regenerate. */
  fix: string | null;
  /** Regenerations before this verdict (0 = first attempt). Set by the worker. */
  attempts: number;
  /** The semantic judge that returned a valid verdict. */
  judge: "jev" | "legacy" | "unavailable";
}

const DEFAULT_PASS_THRESHOLD = 0.7;
const DEFAULT_VOICE_FLOOR = 0.65;

/** The canonical spoken/on-screen text of a script, flattened for the format
 * check. Uses the full `script` (which already runs hook -> beats -> CTA) as the
 * body, falling back to the hook + beat lines when `script` is empty, then adds
 * any on-screen titles NOT already in the body. Deliberately does NOT concatenate
 * both the beat lines and the full script: they repeat the same sentences, which
 * would false-trigger the verifier's repeated-fragment hard-zero. */
export function flattenScriptText(out: VideoScriptOutput): string {
  const core = out.script.trim() || [out.hook, ...out.structure.map((b) => b.line)].join("\n").trim();
  const titles = out.graphSpecs
    .map((g) => g.title?.trim())
    .filter((t): t is string => Boolean(t) && !core.includes(t!));
  return [core, ...titles].filter(Boolean).join("\n");
}

const JUDGE_SYSTEM = [
  "You are a strict editor grading a short-form video SCRIPT (Instagram Reels / TikTok) an AI wrote for an operator to record and post by hand.",
  WRITING_STRUCTURE_GUIDANCE,
  "Apply that guidance inside the existing scores: earned endings and task fit affect voice/relevance; supported factual limits, uncertainty, emotion, and examples affect grounding.",
  "When suggesting fixes, cite the source evidence or missing support and preserve the script's purpose and meaning.",
  "Grade THREE things, each 0.0 to 1.0:",
  "- voice: does the spoken script sound like the operator's real voice per the VOICE ANCHORS (how they actually talk on camera), NOT generic creator/AI/ad-copy patter? Penalize corporate tells, insight-bait, manufactured hype, and filler closers.",
  "- grounding: are the script's specific claims (facts, numbers, results, milestones) supported by the VOICE ANCHORS / IDEA? Penalize invented stats or fabricated outcomes hard.",
  "- relevance: does the script actually deliver on THIS idea's hook + concept and serve the operator's mission, or is it a generic video that could be about anything?",
  "Be harsh: 1.0 is genuinely excellent, 0.7 is the passing bar, below that needs a rewrite.",
  "Output STRICT JSON, no markdown fences, no preamble. First char `{`, last char `}`:",
  '  {"voice":0.0,"grounding":0.0,"relevance":0.0,"reasons":["short reason","..."],"fix":"one actionable instruction to fix the worst problem"}',
  "`reasons` is at most 4 short strings. `fix` is one sentence (or null if every score is >= 0.8).",
].join("\n");

function renderJudgePrompt(out: VideoScriptOutput, ctx: ScriptVerifyContext): string {
  const parts: string[] = [];
  parts.push(`OPERATOR MISSION: ${ctx.objective ?? "(default: grow with on-brand short-form video)"}`);
  parts.push("", `IDEA HOOK: ${ctx.hook}`);
  parts.push(`IDEA CONCEPT: ${ctx.concept ?? "(none)"}`);
  if (ctx.voiceAnchors.length) {
    parts.push("", "VOICE ANCHORS (the operator's real voice + substance — match this):");
    parts.push(...ctx.voiceAnchors.map((a, i) => `[${i + 1}] ${a}`));
  }
  parts.push("", WRITING_STRUCTURE_GUIDANCE);
  // Learned 'structure' rules from the Pattern Breaker: shapes the operator
  // over-uses. Fold into voice — a script that repeats a flagged structure is
  // off-voice (mirrors the Lyra judge's LEARNED PATTERNS TO AVOID block).
  const structureRules = (ctx.patternRules ?? []).filter((p) => p.kind === "structure");
  if (structureRules.length) {
    parts.push(
      "",
      "LEARNED PATTERNS TO AVOID (the operator over-uses these shapes — a script that repeats one should score LOW on voice):",
    );
    parts.push(...structureRules.map((p, i) => `[${i + 1}] ${p.instruction}`));
  }
  parts.push("", "THE SCRIPT TO GRADE:");
  parts.push(`HOOK: ${out.hook}`);
  out.structure.forEach((b, i) => parts.push(`BEAT ${i + 1} (${b.tStart}-${b.tEnd}s, ${b.purpose}): ${b.line}`));
  if (out.script.trim()) parts.push("", `FULL SCRIPT: ${out.script}`);
  parts.push("", "Grade voice, grounding, and relevance. Output the strict JSON verdict only.");
  return parts.join("\n");
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function parseJudge(
  raw: unknown,
): { voice: number; grounding: number; relevance: number; reasons: string[]; fix: string | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!("voice" in o) && !("grounding" in o) && !("relevance" in o)) return null;
  const reasons = Array.isArray(o.reasons)
    ? o.reasons.filter((r): r is string => typeof r === "string").slice(0, 4)
    : [];
  return {
    voice: clamp01(o.voice),
    grounding: clamp01(o.grounding),
    relevance: clamp01(o.relevance),
    reasons,
    fix: typeof o.fix === "string" && o.fix.trim() ? o.fix.trim() : null,
  };
}

/**
 * Verify one generated script. `judge` is the same JSON backend the scripter uses
 * (claude-cli / Bedrock / Gemini), returning parsed JSON | null. An ordinary
 * unavailable judge returns a failed review; denied admission propagates.
 * `attempts` is stamped by the worker's regenerate loop.
 */
export async function verifyScript(
  out: VideoScriptOutput,
  ctx: ScriptVerifyContext,
  judge: JsonFn,
  opts?: { passThreshold?: number; voiceFloor?: number; evaluate?: typeof evaluateJevBoolean },
): Promise<Omit<ScriptVerdict, "attempts">> {
  const threshold = opts?.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const voiceFloor = opts?.voiceFloor ?? DEFAULT_VOICE_FLOOR;

  // Deterministic format over the flattened script. kind "repost" (not "reply")
  // so the reply-only choppy-staccato penalty is skipped — scripts are naturally
  // short stacked lines. No charLimit. Em-dash + slop + repeated-text still apply.
  const body = flattenScriptText(out);
  const format = scoreFormat(
    { kind: "repost", angle: null, body },
    undefined,
    false,
    false,
    ctx.patternRules ? [...ctx.patternRules] : undefined,
  );

  let judged: ReturnType<typeof parseJudge> = null;
  let judgeSource: ScriptVerdict["judge"] = "unavailable";
  let judgeFailed = false;
  const semanticPrompt = renderJudgePrompt(out, ctx);
  try {
    const evaluate = opts?.evaluate ?? evaluateJevBoolean;
    const questions = [
      { true: "This script sounds like the operator's actual voice in the voice anchors, without generic creator or AI patter.", false: "The script sounds generic or unlike the operator." },
      { true: "Every specific claim in the script is supported by the supplied idea or voice anchors.", false: "At least one specific claim is fabricated or unsupported." },
      { true: "The script delivers on the idea hook and concept and serves the operator's objective.", false: "The script misses the promised idea or objective." },
    ] as const;
    const decisions = await Promise.all(questions.map((criteria) => evaluate({
      state: semanticPrompt,
      instructions: "Evaluate one quality dimension of this short-form video script against the supplied context.",
      criteria,
    })));
    if (decisions.every((decision) => decision.kind === "confident")) {
      judged = {
        voice: decisions[0]!.probability,
        grounding: decisions[1]!.probability,
        relevance: decisions[2]!.probability,
        reasons: [],
        fix: null,
      };
      judgeSource = "jev";
    }
  } catch {
    // Fall back to the existing judge below.
  }
  if (!judged) {
    try {
      judged = parseJudge(await judge(JUDGE_SYSTEM, semanticPrompt));
      if (judged) judgeSource = "legacy";
      else judgeFailed = true;
    } catch (error) {
      if (isBudgetAdmissionError(error)) throw error;
      judgeFailed = true;
    }
  }

  const scores: ScriptScores = {
    voice: judged ? judged.voice : 0,

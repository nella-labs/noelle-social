import { RecordingBriefOutputSchema, type RecordingBriefOutput } from "@noelle/contracts";
import type { JsonFn } from "./video-generate.js";
import type { VideoModelOperation } from "./video-gemini.js";

// W6 "briefer" (Nova's media intern). Turns an operator-APPROVED video script
// into a phone-readable RECORDING BRIEF — hook check, timed shot list, b-roll,
// cam angles, props/setting, runtime target, and on-the-day notes. Mirrors
// `createScripter`: the model emits the structured RecordingBriefOutput through
// the injected `JsonFn` seam (claude-cli / Bedrock / Gemini) and FAILS OPEN to
// null; a DETERMINISTIC renderer (below) builds the markdown and counts the
// Forge follow-ups, so the count is never left to the model.

const BRIEF_SYSTEM = [
  "You are Nova's media intern. The operator has APPROVED the short-form video below and is about to",
  "film it. Produce a phone-readable RECORDING BRIEF they can glance at on set: a HOOK CHECK (does the",
  "hook land in the first ~3 seconds — a one-line go/no-go), a timed SHOT LIST (ordered shots with",
  "tStart/tEnd seconds + what to capture), supplementary B-ROLL to grab, CAM ANGLES / framing, PROPS &",
  "SETTING split into what must be IN frame and what must be kept OUT of frame, a RUNTIME TARGET in",
  "seconds, and ON-THE-DAY NOTES (reminders for filming day).",
  "Keep the founder-journey positioning: put anything off-brand or that undercuts the operator's",
  "credibility into props.mustNotBeInFrame so it stays out of shot.",
  "For each on-the-day note, set forgeWouldHelp=true ONLY when a generated asset (an on-screen overlay,",
  "a chart, or a generated image) would materially strengthen that moment — otherwise false. Do NOT",
  "output a count; the flags are summed downstream.",
  "Keep the whole brief tight enough to render under 600 words. Ground the substance in the OPERATOR'S",
  "OWN BRAND & VOICE when provided. Never fabricate stats, results, or milestones.",
  "NEVER use an em dash, en dash, or double hyphen anywhere. Use a comma, parentheses, or two sentences.",
  "Output ONLY JSON matching:",
  '{"title":string,"runtimeTarget":number,"hookCheck":string,',
  '"shotList":[{"tStart":number,"tEnd":number,"description":string}],',
  '"bRoll":[string],"camAngles":[string],',
  '"props":{"inFrame":[string],"mustNotBeInFrame":[string]},',
  '"onTheDayNotes":[{"note":string,"forgeWouldHelp":boolean}]}.',
].join(" ");

export interface BrieferInput {
  /** The approved idea's hook (usually the working title of the brief). */
  hook: string;
  concept: string | null;
  /** The approved script body the brief plans the shoot around. */
  script: string;
  platform: string;
  /** Vault brand/voice snippets to keep the framing on-brand (optional). */
  brandContext?: readonly string[];
  /** Runtime hint in seconds derived from the draft's timed structure (optional). */
  runtimeHintSec?: number | null;
  operation?: VideoModelOperation;
}

export interface VideoBriefer {
  brief(input: BrieferInput): Promise<RecordingBriefOutput | null>;
}

function renderBrandContext(snippets: readonly string[] | undefined): string {
  if (!snippets || snippets.length === 0) return "";
  return [
    "",
    "OPERATOR'S OWN BRAND & VOICE (keep the framing on-brand; off-brand signals go in mustNotBeInFrame):",
    ...snippets.map((s) => `- ${s.replace(/\s+/g, " ").slice(0, 400)}`),
  ].join("\n");
}

export function createBriefer(json: JsonFn): VideoBriefer {
  return {
    async brief(input) {
      const user = [
        `PLATFORM: ${input.platform}`,
        `HOOK: ${input.hook}`,
        `CONCEPT: ${input.concept ?? "(none)"}`,
        input.runtimeHintSec && input.runtimeHintSec > 0
          ? `RUNTIME HINT (seconds, from the script's timed structure): ${Math.round(input.runtimeHintSec)}`
          : "RUNTIME HINT: (none — infer a sensible target for the platform)",
        "",
        "APPROVED SCRIPT (plan the shoot around exactly this):",
        input.script.trim() || "(empty script)",
        renderBrandContext(input.brandContext),
      ].join("\n");
      const parsed = input.operation ? await json(BRIEF_SYSTEM, user, input.operation) : await json(BRIEF_SYSTEM, user);
      if (!parsed) return null;
      const safe = RecordingBriefOutputSchema.safeParse(parsed);
      return safe.success ? safe.data : null;
    },
  };
}

// --- pure renderer + counter (unit-testable, no LLM, no IO) -----------------

/**
 * `forge_followups` = the number of on-the-day notes flagged `forgeWouldHelp`.
 * DETERMINISTIC and computed here, never taken from the model, so the count is
 * always an honest reflection of the flags. This plain integer + the per-note
 * flags are the forward hook a later Forge skill consumes; no Forge integration
 * is built now.
 */
export function countForgeFollowups(brief: RecordingBriefOutput): number {
  return brief.onTheDayNotes.filter((n) => n.forgeWouldHelp).length;
}

/** Count words in the rendered markdown (for the <=600-word phone-first check). */
export function countWords(md: string): number {
  return md.trim().split(/\s+/).filter(Boolean).length;
}

/** Format a whole number of seconds as `Ns` or `MmSSs` (no em dashes). */
function formatSeconds(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem}s`;
}

function renderList(items: readonly string[]): string {
  if (items.length === 0) return "(none)";
  return items.map((i) => `- ${i}`).join("\n");
}

/**
 * Render the structured brief as phone-first markdown the operator reads on set.
 * PURE + deterministic: same input → same output, no IO. Keeps the Paperclip
 * media-intern's full section set (hook check, shot list, b-roll, cam angles,
 * props/setting, runtime target, on-the-day notes) and TAGS forge-flagged notes
 * with a `[Forge]` marker so the operator sees why `forge_followups` is what it
 * is. The forge follow-up total is rendered at the foot for a fast glance.
 */
export function renderBriefMarkdown(brief: RecordingBriefOutput): string {
  const shots =
    brief.shotList.length === 0
      ? "(none)"
      : brief.shotList
          .map((s) => `- ${formatSeconds(s.tStart)}-${formatSeconds(s.tEnd)}: ${s.description}`)
          .join("\n");

  const notes =
    brief.onTheDayNotes.length === 0
      ? "(none)"
      : brief.onTheDayNotes.map((n) => `- ${n.forgeWouldHelp ? "[Forge] " : ""}${n.note}`).join("\n");

  const forgeCount = countForgeFollowups(brief);

  return [
    `# ${brief.title}`,
    "",
    `Runtime target: ${formatSeconds(brief.runtimeTarget)}`,
    "",
    "## Hook check",
    brief.hookCheck,
    "",
    "## Shot list",
    shots,
    "",
    "## B-roll",
    renderList(brief.bRoll),
    "",
    "## Cam angles",
    renderList(brief.camAngles),
    "",
    "## Props & setting",
    "In frame:",
    renderList(brief.props.inFrame),
    "Keep OUT of frame:",
    renderList(brief.props.mustNotBeInFrame),
    "",
    "## On-the-day notes",
    notes,
    "",
    `Forge follow-ups: ${forgeCount}`,
  ].join("\n");
}

import {
  VideoIdeasOutSchema,
  type VideoIdeasOut,
  VideoScriptOutputSchema,
  type VideoScriptOutput,
  VideoTeardownSchema,
} from "@noelle/contracts";
import { WRITING_STRUCTURE_GUIDANCE, cliTimeoutMs, createBudgetedBackend, isBudgetAdmissionError,
  ModelNotDispatchedError, type EngineBackend, type DynamicPattern } from "@noelle/runtime";
import type { UltraProfileRow, ClipBrief } from "./brand-guide-db.js";
import { requestVideoGeminiJson, videoMeteringForOperation, type VideoGeminiOptions,
  type VideoModelMetering, type VideoModelOperation } from "./video-gemini.js";
import { extractVideoJson } from "./video-model-json.js";

// W4 generators. The ideator (Muse) proposes idea cards grounded on the Brand
// Guide + top clips; the scripter (Scribe) turns an approved idea into a timed
// structure + script + asset suggestions. Both emit structured JSON through an
// injected `JsonFn` so the worker can route them to the reliable claude-cli /
// Bedrock backend (the rest of Noelle's text path) with the Gemini key seam as
// a fallback. Ordinary provider failures return null; denied admission
// propagates. Unknown model outcomes never fabricate content.

/**
 * The minimal text→JSON seam the generators depend on. `(system, user) → parsed
 * JSON | null`. Structurally identical to objective-grade's `JsonCaller`; both
 * keep ordinary provider failures as null; denied admission propagates.
 */
export type JsonFn = (system: string, user: string, operation?: VideoModelOperation) => Promise<unknown | null>;

export type { VisionAuthClient } from "./video-gemini.js";

/**
 * Wrap any EngineBackend (claude-cli / Bedrock / Anthropic) into the generators'
 * `JsonFn` seam: send the system+user prompt, extract JSON from the reply,
 * return null on ordinary failures and propagate denied admission.
 * Supporting backends own the same per-call deadline;
 * the provider guard preserves an unknown outcome for noncancellable injected calls.
 */
export function createBackendJsonFn(
  backend: EngineBackend,
  model: string,
  opts?: { timeoutMs?: number; metering?: VideoModelMetering },
): JsonFn {
  const configuredTimeoutMs = opts?.timeoutMs ?? 90_000;
  return async (system, user, operation) => {
    try {
      const timeoutMs = cliTimeoutMs(configuredTimeoutMs);
      const deadline = performance.now() + timeoutMs;
      const timed: EngineBackend = { call: async request => {
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining < 1) throw new Error("Video generation deadline exceeded");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            backend.call({ ...request, timeoutMs: remaining }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Video JSON deadline exceeded")), remaining);
              timer.unref?.();
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } };
      const metering = videoMeteringForOperation(opts?.metering, operation, deadline);
      const admitted = metering ? createBudgetedBackend(timed, metering) : timed;
      const res = await admitted.call({ system, prompt: user, model, timeoutMs });
      if (performance.now() >= deadline) return null;
      const parsed = extractVideoJson(res.text);
      return performance.now() < deadline ? parsed : null;
    } catch (error) {
      if (isBudgetAdmissionError(error) || error instanceof ModelNotDispatchedError) throw error;
      return null;
    }
  };
}

interface VertexOpts extends VideoGeminiOptions {
  temperature?: number;
}

async function vertexJson(opts: VertexOpts, system: string, user: string, operation?: VideoModelOperation): Promise<unknown | null> {
  return requestVideoGeminiJson(opts, {
    system, parts: [{ text: user }], apiKeyParts: [{ text: `${system}\n\n${user}` }],
    temperature: opts.temperature ?? 0.5,
  }, undefined, operation);
}

// Shared anti-slop directive for Nova's generators. Mirrors the em-dash HARD-ZERO
// + AI-tell bans the Lyra/Vega drafter+verifier enforce (prompts.ts / draftVerifier.ts)
// so Nova's spoken lines read like the operator, not ad copy. The deterministic
// `sanitizeScriptOutput` net below guarantees no em dash ever survives to the UI
// even if the model ignores this — but the prompt keeps the substance clean too.
const ANTI_SLOP = [
  "VOICE + ANTI-SLOP (mandatory).",
  "NEVER use an em dash, en dash, or double hyphen anywhere (not in the hook, the beats, the script, on-screen text, or notes). There is no acceptable use; a single one fails the script outright. Use a comma, parentheses, or two separate sentences instead.",
  "Write every spoken line in the operator's real voice, the way a person actually talks on camera, grounded in the OPERATOR'S OWN BRAND & VOICE below.",
  "No corporate or AI tells: no 'the gap between X and Y', no 'hits different', no 'lands well', no insight-bait templates, no manufactured hype ('this is huge', 'game changer'), and no filler closers ('curious to hear', 'excited to see where this goes', 'let me know what you think').",
  "Do not fabricate stats, results, follower counts, or milestones. Ground every claim in the Brand Guide and operator voice; if you have no real number, don't imply one.",
].join(" ");

/**
 * Deterministic anti-slop net. Strips em/en dashes + double hyphens from EVERY
 * string field of a generated script, replacing them with a comma so the line
 * still reads. Runs after schema validation, so a stubborn model can't leak one
 * past the regenerate loop into the UI. Mirrors draftVerifier's EM_DASH hard-zero.
 */
function scrubEmDash(s: string): string {
  return s
    .replace(/\s*(?:—|–|―|--)\s*/g, ", ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,+/g, ",")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function sanitizeScriptOutput(out: VideoScriptOutput): VideoScriptOutput {
  return {
    ...out,
    hook: scrubEmDash(out.hook),
    script: scrubEmDash(out.script),
    structure: out.structure.map((b) => ({
      ...b,
      purpose: scrubEmDash(b.purpose),
      line: scrubEmDash(b.line),
    })),
    transitions: out.transitions.map((t) => ({ ...t, at: scrubEmDash(t.at) })),
    sounds: out.sounds.map((s) => ({
      ...s,
      name: scrubEmDash(s.name),
      ...(s.reason ? { reason: scrubEmDash(s.reason) } : {}),
    })),
    graphSpecs: out.graphSpecs.map((g) => ({
      ...g,
      ...(g.title ? { title: scrubEmDash(g.title) } : {}),
      ...(g.note ? { note: scrubEmDash(g.note) } : {}),
      ...(g.data !== undefined ? { data: scrubDataLabels(g.data) } : {}),
    })),
  };
}

/** `graphSpecs[].data` is loosely typed (z.unknown). When it's the expected
 * array of {label,value} points, scrub em dashes out of each string `label`;
 * anything else passes through untouched. */
function scrubDataLabels(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return data.map((pt) =>
    pt && typeof pt === "object" && typeof (pt as { label?: unknown }).label === "string"
      ? { ...(pt as object), label: scrubEmDash((pt as { label: string }).label) }
      : pt,
  );
}

// --- grounding renderers ---
function renderGuide(profiles: UltraProfileRow[]): string {
  if (profiles.length === 0) return "(no Brand Guide yet — ground on the top clips below)";
  return profiles
    .map((p) => `• [${p.scope}:${p.subject}] ${JSON.stringify(p.profile).slice(0, 1200)}`)
    .join("\n");
}
/**
 * Render a clip's teardown as the FORM lesson it actually is, instead of dumping
 * 800 chars of raw truncated JSON (which chopped off the beat structure and the
 * single most useful field, `whyItWorked`, since they sit late in the object).
 * Parses the stored teardown and renders the hook / beat structure / transitions
 * / pacing / CTA / sound / why-it-worked as compact prose the model can emulate.
 * Falls back to a short JSON slice if the teardown doesn't match the schema.
 */
function renderTeardown(raw: unknown): string {
  const parsed = VideoTeardownSchema.safeParse(raw);
  if (!parsed.success) return `   teardown: ${JSON.stringify(raw).slice(0, 500)}`;
  const t = parsed.data;
  const cap = (s: string | undefined, n: number) => (s ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");
  const lines: string[] = [];
  lines.push(`   hook (${t.hook.type}): "${cap(t.hook.text, 160)}"${t.hook.reason ? ` — ${cap(t.hook.reason, 120)}` : ""}`);
  if (t.beats.length) {
    const beats = t.beats.slice(0, 8).map((b) => `${b.tStart}-${b.tEnd}s ${cap(b.purpose, 40)}`).join(" · ");
    lines.push(`   structure: ${beats}`);
  }
  const transitions = [...new Set(t.transitions.map((x) => x.type))].join(", ");
  const pacing = `${t.pacing.cutsPerSec.toFixed(1)} cuts/s, ~${t.pacing.avgBeatSec.toFixed(1)}s/beat`;
  lines.push(`   transitions: ${transitions || "none"} | pacing: ${pacing}`);
  const sound = t.sound.trackName || t.sound.musicId || "unknown";
  const soundTags = [t.sound.trending ? "trending" : "", t.sound.beatSynced ? "beat-synced" : ""].filter(Boolean).join(", ");
  const cta = t.cta.present ? `CTA (${t.cta.placement}): "${cap(t.cta.text, 100)}"` : "no CTA";
  lines.push(`   ${cta} | sound: ${sound}${soundTags ? ` (${soundTags})` : ""}`);
  if (t.whyItWorked) lines.push(`   why it worked: ${cap(t.whyItWorked, 320)}`);
  return lines.join("\n");
}

function renderClips(clips: ClipBrief[]): string {
  if (clips.length === 0) return "(no clips harvested yet)";
  return clips
    .map(
      (c) =>
        `• id=${c.id} @${c.author_handle} views=${c.views ?? "unknown"} likes=${c.likes ?? "unknown"} :: ${c.caption.slice(0, 200)}` +
        (c.teardown ? `\n${renderTeardown(c.teardown)}` : ""),
    )
    .join("\n");
}

/**
 * Learned Pattern Breaker rules rendered for a generator prompt — the operator's
 * over-used habits (a pet phrase, a repeated shape) discovered from their corpus.
 * Mirrors how the Lyra drafter injects them into its system prompt so a script
 * never leans on a flagged habit. Empty when there are no active rules.
 */
function renderPatternRules(rules: readonly DynamicPattern[] | undefined): string {
  if (!rules || rules.length === 0) return "";
  return [
    "",
    "LEARNED PATTERNS TO AVOID (the operator over-uses these across their content; do NOT repeat them):",
    ...rules.slice(0, 12).map((r) => `• ${r.instruction || r.label}`),
  ].join("\n");
}
/**
 * Operator's own brand/voice, pulled from the vault (BM25 snippets). Grounds
 * generation in what they actually do + how they sound — the form comes from the
 * watched creators, the substance + voice from here. Empty when no vault.
 */
function renderBrandContext(snippets: readonly string[] | undefined): string {
  if (!snippets || snippets.length === 0) return "";
  return [
    "",
    "OPERATOR'S OWN BRAND & VOICE (from their vault — match this substance + voice; the clips are only for FORM):",
    ...snippets.map((s) => `• ${s.replace(/\s+/g, " ").slice(0, 400)}`),
  ].join("\n");
}

// --- Ideator (Muse) ---
const IDEATE_SYSTEM = [
  "You are Nova, a short-form video ideation strategist. You are given the operator's distilled",
  "VIDEO BRAND GUIDE (what consistently performs for the creators they study) and the TOP-PERFORMING",
  "clips in their niche. Propose fresh, on-brand video IDEAS the operator could film. Each idea = a",
  "scroll-stopping HOOK + a one-paragraph CONCEPT, grounded in the proven patterns (cite the clip ids",
  "that inspired it in inspirationClipIds). Original substance, proven form. Never fabricate metrics.",
  WRITING_STRUCTURE_GUIDANCE,
  ANTI_SLOP,
  "Output ONLY JSON: {\"ideas\":[{\"hook\":string,\"concept\":string,\"angle\":string,\"pillar\":string,\"inspirationClipIds\":[string]}]}",
].join(" ");

export interface VideoIdeator {
  ideate(input: {
    objective: string | null;
    count: number;
    profiles: UltraProfileRow[];
    clips: ClipBrief[];
    /** Vault brand/voice snippets to ground substance + voice (optional). */
    brandContext?: readonly string[];
  }): Promise<VideoIdeasOut | null>;
}

/**
 * A bare Gemini JSON caller over the same Vertex seam — for callers that own
 * their own prompt + schema (e.g. the harvester's objective grader). Returns the
 * parsed JSON or null (fail-open). Keeps the Vertex auth/key plumbing in one file.
 */
export function createVertexJsonFn(opts: VertexOpts): JsonFn {
  return (system, user, operation) => vertexJson(opts, system, user, operation);
}

/**
 * Backend-agnostic ideator: builds the grounded prompt and parses the reply via
 * the injected `JsonFn`. The worker wires `json` to claude-cli / Bedrock (with a
 * Gemini fallback) — see `createTextJsonFn`. `createVertexIdeator` keeps the old
 * Gemini-only construction for callers/tests that still pass VertexOpts.
 */
export function createIdeator(json: JsonFn): VideoIdeator {
  return {
    async ideate(input) {
      const user = [
        `OPERATOR MISSION: ${input.objective ?? "(default: grow with on-brand short-form video)"}`,
        `PROPOSE ${input.count} IDEAS.`,
        "",
        "VIDEO BRAND GUIDE:",
        renderGuide(input.profiles),
        renderBrandContext(input.brandContext),
        "",
        "TOP-PERFORMING CLIPS (id @handle metrics :: caption [+ teardown]):",
        renderClips(input.clips),
      ].join("\n");
      const parsed = await json(IDEATE_SYSTEM, user);
      if (!parsed) return null;
      const safe = VideoIdeasOutSchema.safeParse(parsed);
      return safe.success ? safe.data : null;
    },
  };
}

export function createVertexIdeator(opts: VertexOpts): VideoIdeator {
  return createIdeator((system, user) => vertexJson({ ...opts, temperature: 0.7 }, system, user));
}

// --- Scripter (Blueprint + Scribe) ---
const SCRIPT_SYSTEM = [
  "You are Nova, a short-form video scripter writing in the operator's voice. Given a video IDEA, the",
  "operator's VIDEO BRAND GUIDE, and EXEMPLAR clips (their hooks / structure / pacing / transitions),",
  "produce a complete short-form plan: a punchy spoken HOOK, a timed STRUCTURE (ordered beats with",
  "tStart/tEnd seconds + purpose + the line to say/show), the full SCRIPT (hook → beats → CTA), and",
  "suggested TRANSITIONS, SOUNDS, and on-screen GRAPHS. Match the proven FORM; keep the substance",
  "original and on-brand. Never fabricate stats. Output ONLY JSON matching:",
  '{"hook":string,"structure":[{"tStart":number,"tEnd":number,"purpose":string,"line":string}],"script":string,',
  '"transitions":[{"at":string,"type":"cut|jump_cut|match_cut|whip_pan|zoom|crossfade|slide|speed_ramp|other"}],',
  '"sounds":[{"name":string,"reason":string,"trending":boolean}],',
  '"graphSpecs":[{"kind":"bar|line|time_series|stat|lower_third|kinetic_text|other","title":string,"data":[{"label":string,"value":number}],"tStart":number,"note":string}]}.',
  "GRAPHS render as real on-screen overlays, so emit RENDERABLE content, not just a description:",
  "for bar/line/time_series ALWAYS include `data` as 2+ {label,value} points (illustrative magnitudes are fine, never fabricate as fact);",
  "for kinetic_text put the EXACT on-screen words in `title` (≤6 words, punchy);",
  "for lower_third put the on-screen label in `title` and an optional sub-label in `note`.",
  "ALWAYS set `tStart` on every graph to the SECOND it appears on screen, inside one of the structure beats' tStart/tEnd windows, so it pairs to the right line.",
  "`note` is the editor/animation direction. Put footage the operator must film as a bracket cue INSIDE the relevant beat's `line` (e.g. line: \"...working late [B-ROLL: person at a laptop at night]\" or \"[SCREEN RECORDING: opening a blank doc]\") so each beat carries its own footage.",
  WRITING_STRUCTURE_GUIDANCE,
  ANTI_SLOP,
].join(" ");

export interface VideoScripter {
  script(input: {
    hook: string;
    concept: string | null;
    objective: string | null;
    profiles: UltraProfileRow[];
    exemplars: ClipBrief[];
    /** Vault brand/voice snippets to ground substance + voice (optional). */
    brandContext?: readonly string[];
    /**
     * Verifier fix from a failed prior attempt, appended to the prompt so the
     * regenerate targets the exact problem (em dash, off-voice, slop). Absent on
     * the first attempt. Mirrors the Lyra/Vega drafter's regenerate-with-critique.
     */
    critique?: string | null;
    /** Learned Pattern Breaker rules to avoid (the operator's over-used habits). */
    patternRules?: readonly DynamicPattern[];
  }): Promise<VideoScriptOutput | null>;
}

export function createScripter(json: JsonFn): VideoScripter {
  return {
    async script(input) {
      const user = [
        `OPERATOR MISSION: ${input.objective ?? "(default)"}`,
        `IDEA HOOK: ${input.hook}`,
        `IDEA CONCEPT: ${input.concept ?? "(none)"}`,
        "",
        "VIDEO BRAND GUIDE:",
        renderGuide(input.profiles),
        renderBrandContext(input.brandContext),
        "",
        "EXEMPLAR CLIPS to emulate the FORM of (not the topic):",
        renderClips(input.exemplars),
        renderPatternRules(input.patternRules),
        ...(input.critique
          ? ["", `FIX THESE PROBLEMS from your last attempt (mandatory): ${input.critique}`]
          : []),
      ].join("\n");
      const parsed = await json(SCRIPT_SYSTEM, user);
      if (!parsed) return null;
      const safe = VideoScriptOutputSchema.safeParse(parsed);
      return safe.success ? sanitizeScriptOutput(safe.data) : null;
    },
  };
}

export function createVertexScripter(opts: VertexOpts): VideoScripter {
  return createScripter((system, user) => vertexJson({ ...opts, temperature: 0.6 }, system, user));
}

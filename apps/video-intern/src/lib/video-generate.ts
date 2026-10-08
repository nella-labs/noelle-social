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

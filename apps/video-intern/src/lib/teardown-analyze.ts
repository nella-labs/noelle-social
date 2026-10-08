import { basename, dirname } from "node:path";
import { VideoTeardownSchema, type VideoTeardown } from "@noelle/contracts";
import { cliTimeoutMs } from "@noelle/runtime";
import { readLocalContentMedia } from "@noelle/runtime/content-media-read";
import { readImageMimeType } from "@noelle/runtime/image-mime";
import { requestVideoGeminiJson, type VideoGeminiOptions, type VideoModelOperation } from "./video-gemini.js";

// Multimodal teardown. Given a clip's transcript + keyframes + metrics, ask Gemini
// to output the structured VideoTeardownSchema JSON (hook, beats, transitions,
// on-screen text, pacing, CTA, sound, why-it-worked). Two transports:
//   - Gemini API key (generativelanguage) — the reliable path on the Lima VM,
//     where Vertex user-ADC dies with invalid_rapt. Preferred when NOELLE_GEMINI_API_KEY is set.
//   - Vertex ADC (Bearer) — managed/Vercel fallback.
// Ordinary auth, provider and output failures return null; monetary admission
// errors propagate. Unknown outcomes never fabricate a teardown.
//
// First cut: transcript + extracted keyframes (not native-video upload).

export type { VisionAuthClient } from "./video-gemini.js";

export interface TeardownAnalyzeInput {
  caption: string;
  transcript: string;
  keyframePaths: string[];
  cutTimestamps: number[];
  metrics: { views: number | null; likes: number | null; comments: number | null; shares: number | null; durationS: number | null };
  operation?: VideoModelOperation;
}

export interface VideoAnalyzer {
  analyze(input: TeardownAnalyzeInput): Promise<VideoTeardown | null>;
}

const SYSTEM = [
  "You are a short-form video analyst. You are given a viral Instagram/TikTok clip:",
  "its transcript, a few keyframes (in order), scene-cut timestamps, and engagement metrics.",
  "Break it down into REUSABLE STRUCTURE — not a summary of the topic. Identify the hook (the",
  "first ~3s and WHY it stops the scroll), the ordered beats with timestamps + purpose, the",
  "transitions (type + when), on-screen text/graphics, pacing (cuts/sec, avg beat length,",
  "words/sec), the CTA, the sound, and a grounded hypothesis for why it retained + performed.",
  "Output ONLY JSON matching this exact shape — no prose, no markdown:",
  '{"hook":{"text":string,"type":"question|bold_claim|pattern_interrupt|story_open|stat|callout|tease|other","reason":string},',
  '"beats":[{"tStart":number,"tEnd":number,"purpose":string,"text":string}],',
  '"transitions":[{"t":number,"type":"cut|jump_cut|match_cut|whip_pan|zoom|crossfade|slide|speed_ramp|other"}],',
  '"onscreen":[{"t":number,"kind":"caption|title|kinetic_text|graphic|chart|lower_third|emoji|other","text":string,"style":string}],',
  '"pacing":{"cutsPerSec":number,"avgBeatSec":number,"wordsPerSec":number},',
  '"cta":{"present":boolean,"text":string,"placement":"start|mid|end|none"},',
  '"sound":{"musicId":string,"trackName":string,"energy":"low|medium|high","trending":boolean,"beatSynced":boolean},',
  '"whyItWorked":string}',
].join(" ");

async function loadFrames(paths: string[], deadline: number): Promise<Array<{ mimeType: string; data: string }>> {
  const out: Array<{ mimeType: string; data: string }> = [];
  for (const p of paths) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) break;
    try {
      const buf = await readLocalContentMedia(dirname(p), basename(p), { timeoutMs: Math.min(remaining, 30_000) });
      const mimeType = readImageMimeType(buf);
      if (mimeType && mimeType !== "image/gif") out.push({ mimeType, data: Buffer.from(buf).toString("base64") });
    } catch {
      /* skip unreadable frame */
    }
  }
  return out;
}

/** The text part (caption + metrics + cuts + transcript). Exported for tests. */
export function buildMetaText(input: TeardownAnalyzeInput): string {
  return [
    `CAPTION: ${input.caption || "(none)"}`,
    `DURATION_S: ${input.metrics.durationS ?? "unknown"}`,
    `METRICS: views=${input.metrics.views ?? "unknown"} likes=${input.metrics.likes ?? "unknown"} comments=${input.metrics.comments ?? "unknown"} shares=${input.metrics.shares ?? "unknown"}`,
    `SCENE_CUTS_S: ${input.cutTimestamps.slice(0, 40).map((t) => t.toFixed(2)).join(", ") || "(none detected)"}`,
    `TRANSCRIPT:\n${input.transcript.slice(0, 6000) || "(no speech / music only)"}`,
  ].join("\n");
}

/** Vertex-shaped parts (camelCase inlineData). Exported for tests. */
export function buildTeardownParts(
  input: TeardownAnalyzeInput,
  frames: Array<{ mimeType: string; data: string }>,
): Array<Record<string, unknown>> {
  return [
    { text: buildMetaText(input) },
    ...frames.map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.data } })),
  ];
}

export function createVertexVideoAnalyzer(opts: VideoGeminiOptions): VideoAnalyzer {
  return {
    async analyze(input) {
      let deadline: number;
      try { deadline = performance.now() + cliTimeoutMs(opts.timeoutMs ?? 90_000); }
      catch { return null; }
      const frames = await loadFrames(input.keyframePaths.slice(0, 6), deadline);
      const request = {
        system: SYSTEM,
        parts: buildTeardownParts(input, frames),
        apiKeyParts: [
          { text: `${SYSTEM}\n\n${buildMetaText(input)}` },
          ...frames.map(frame => ({ inline_data: { mime_type: frame.mimeType, data: frame.data } })),
        ],
        temperature: 0.2,
      };
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) return null;
      return requestVideoGeminiJson({ ...opts, timeoutMs: remaining }, request, value => {
        const parsed = VideoTeardownSchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      }, input.operation, deadline);
    },
  };
}

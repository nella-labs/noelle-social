import type {
  VideoTeardown,
  VideoUltraProfile,
  VideoHookType,
  VideoTransitionType,
} from "@noelle/contracts";
import { measuredCountMean, readSourceCount } from "@noelle/runtime/source-values";

// W3 distillation — aggregate a creator's / niche's / account's teardowns into a
// Video Brand Guide (VideoUltraProfile). Deterministic + pure (no LLM): the
// teardowns already carry the structure, so we roll them up. The guide is only
// useful if it's concrete, so we carry the actual artifacts through — the real
// hook line and why it stops the scroll, the structure of the best clip that
// used it, real CTA lines — not just the hook/transition categories.
// Unit-tested; the worker just persists it.

export interface TeardownWithMetrics {
  clipId: string;
  teardown: VideoTeardown;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface DistilledProfile {
  profile: VideoUltraProfile;
  avgViews: number | null;
  avgLikes: number | null;
  avgComments: number | null;
  clipsAnalyzed: number;
  sampleClipIds: string[];
}

type HookEntry = { type: VideoHookType; example: string; reason?: string; views?: number };

// Plain-language pacing label so the card reads "fast" instead of only "0.16 cuts/s".
// Exported so the skiller's SKILL.md renderer labels pacing identically (single
// source of truth — the Brand Guide card and the emitted skill agree).
export function paceLabel(cutsPerSec: number): string {
  if (cutsPerSec >= 0.25) return "rapid";
  if (cutsPerSec >= 0.12) return "fast";
  if (cutsPerSec >= 0.05) return "steady";
  return "slow";
}

// A grounded, example-led summary of what wins — names the actual winning hook
// line, the shape, the pace, the CTA, and the sound, instead of just echoing the
// hook/transition categories.
function buildWhatPerforms(
  top: TeardownWithMetrics | undefined,
  hookLibrary: HookEntry[],
  ctaExamples: string[],
  pacing: { cutsPerSec: number } | undefined,
  soundPatterns: string[],
): string {
  if (!top) return "";
  const lead = hookLibrary[0];
  const topHook = (lead?.type ?? "varied").replace(/_/g, " ");
  const hookLine = (lead?.example ?? top.teardown.hook.text ?? "").trim();
  const beats = top.teardown.beats.length || 0;
  const placement = top.teardown.cta.placement;
  const cta = (ctaExamples[0] ?? top.teardown.cta.text ?? "").trim();

  const parts: string[] = [];
  parts.push(
    hookLine
      ? `${top.views === null ? "Observed clips" : "Top measured clips"} open on a ${topHook} hook like "${hookLine}"`
      : `${top.views === null ? "Observed clips" : "Top measured clips"} open on a ${topHook} hook`,
  );
  if (beats) {
    const pace = pacing ? `${paceLabel(pacing.cutsPerSec)} ${pacing.cutsPerSec.toFixed(2)} cuts/s` : "a tight";
    parts.push(`then move through ${beats} beats at a ${pace} pace`);
  }
  if (placement !== "none") {
    parts.push(cta ? `to a ${placement} CTA ("${cta}")` : `to a ${placement} CTA`);
  }
  let out = parts.join(", ") + ".";
  if (soundPatterns.length) out += ` Sound: ${soundPatterns.join(", ")}.`;
  return out;
}

export function distillUltraProfile(input: TeardownWithMetrics[]): DistilledProfile {
  const byViews = (a: number | null | undefined, b: number | null | undefined) =>
    a == null ? (b == null ? 0 : 1) : b == null ? -1 : b - a;
  const items = input.map(item => ({ ...item, views: readSourceCount(item.views),
    likes: readSourceCount(item.likes), comments: readSourceCount(item.comments) }))
    .sort((a, b) => byViews(a.views, b.views));
  const n = items.length;

  // Per hook type, keep the highest-performing example + why it works.
  const byHookType = new Map<VideoHookType, HookEntry>();
  const transitionCounts = new Map<VideoTransitionType, number>();
  // Per unique beat-sequence, keep the top-performing clip as the template.
  const byStructure = new Map<string, { name: string; beats: string[]; example: string; views?: number }>();
  const ctaByText = new Map<string, number | null>();
  const soundPatterns = new Set<string>();
  let cuts = 0;
  let beat = 0;
  let words = 0;
  let pacingN = 0;

  for (const it of items) {
    const t = it.teardown;
    const prevHook = byHookType.get(t.hook.type);
    if (!prevHook) {
      byHookType.set(t.hook.type, {
        type: t.hook.type,
        example: t.hook.text,
        reason: t.hook.reason,
        ...(it.views === null ? {} : { views: it.views }),
      });
    }
    for (const tr of t.transitions) transitionCounts.set(tr.type, (transitionCounts.get(tr.type) ?? 0) + 1);
    if (t.pacing) {
      cuts += t.pacing.cutsPerSec;
      beat += t.pacing.avgBeatSec;
      words += t.pacing.wordsPerSec;
      pacingN += 1;
    }
    if (t.beats.length) {
      const beats = t.beats.map((b) => b.purpose);
      const key = beats.join(">");
      const prevTpl = byStructure.get(key);
      if (!prevTpl) {
        byStructure.set(key, {
          name: `${t.hook.type} → ${t.cta.placement} CTA`,
          beats,
          example: t.hook.text,
          ...(it.views === null ? {} : { views: it.views }),
        });
      }
    }
    if (t.cta.present && t.cta.text?.trim()) {
      const text = t.cta.text.trim();
      if (!ctaByText.has(text)) ctaByText.set(text, it.views);
    }
    if (t.sound.trending) soundPatterns.add("trending audio");
    if (t.sound.energy) soundPatterns.add(`${t.sound.energy} energy`);
    if (t.sound.beatSynced) soundPatterns.add("beat-synced cuts");
  }

  const hookLibrary = [...byHookType.values()].sort((a, b) => byViews(a.views, b.views));
  const transitionVocabulary = [...transitionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
  const structureTemplates = [...byStructure.values()]
    .sort((a, b) => byViews(a.views, b.views))
    .slice(0, 5);
  const ctaExamples = [...ctaByText.entries()]
    .sort((a, b) => byViews(a[1], b[1]))
    .slice(0, 4)
    .map(([text]) => text);
  const pacingFingerprint = pacingN
    ? { cutsPerSec: cuts / pacingN, avgBeatSec: beat / pacingN, wordsPerSec: words / pacingN }
    : undefined;
  const soundList = [...soundPatterns];

  const profile: VideoUltraProfile = {
    hookLibrary,
    transitionVocabulary,
    ...(pacingFingerprint ? { pacingFingerprint } : {}),
    structureTemplates,
    soundPatterns: soundList,
    ctaExamples,
    whatPerforms: buildWhatPerforms(items[0], hookLibrary, ctaExamples, pacingFingerprint, soundList),
  };

  return {
    profile,
    avgViews: measuredCountMean(items.map(i => i.views)),
    avgLikes: measuredCountMean(items.map(i => i.likes)),
    avgComments: measuredCountMean(items.map(i => i.comments)),
    clipsAnalyzed: n,
    sampleClipIds: items.filter(i => i.views !== null).slice(0, 10).map((i) => i.clipId),
  };
}

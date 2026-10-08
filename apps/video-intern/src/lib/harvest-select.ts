import type { VideoClip } from "@noelle/video-apify";
import type { VideoFeederConfig } from "@noelle/contracts";
import { measuredSourceRatio, readSourceCount } from "@noelle/runtime/source-values";

// W1 Harvest — configured filter lanes applied per pull. Pure functions
// so they're unit-tested without Apify/DB.

export function engagement(c: VideoClip): number | null {
  const values = [c.likes, c.comments, c.shares, c.saves].map(value => readSourceCount(value));
  if (values.some(value => value === null)) return null;
  const sum = values.reduce<number>((total, value) => total + value!, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}
function engRate(c: VideoClip): number | null {
  return measuredSourceRatio(engagement(c), c.views);
}
/** Observed views divided by the captured follower count, when both are measured. */
export function outperformerRatio(c: VideoClip): number | null {
  return measuredSourceRatio(c.views, c.authorFollowerCount);
}

/**
 * Creator lane: top-N-by-views ∪ top-N-by-engagement ∪ outperformers, deduped.
 * Outperformers EXCLUDE clips already chosen by the top-N lanes — the
 * "...but not in those 10 I already got".
 */
export function selectCreatorClips(clips: VideoClip[], cfg: VideoFeederConfig): VideoClip[] {
  const chosen = new Map<string, VideoClip>();
  for (const c of clips.filter(c => readSourceCount(c.views) !== null).sort((a, b) => b.views! - a.views!).slice(0, cfg.topByViews)) {
    chosen.set(c.id, c);
  }
  if (cfg.topByEngagement > 0) {
    for (const c of clips.filter(c => engRate(c) !== null).sort((a, b) => engRate(b)! - engRate(a)!).slice(0, cfg.topByEngagement)) {
      chosen.set(c.id, c);
    }
  }
  if (cfg.outperformers.n > 0) {
    const out = clips
      .filter((c) => { const ratio = outperformerRatio(c); return ratio !== null && ratio >= cfg.outperformers.ratio && !chosen.has(c.id); })
      .sort((a, b) => outperformerRatio(b)! - outperformerRatio(a)!)
      .slice(0, cfg.outperformers.n);
    for (const c of out) chosen.set(c.id, c);
  }
  return [...chosen.values()];
}

/** Niche lane: drop below the min-views floor, then keep the top-N by views. */
export function selectNicheClips(clips: VideoClip[], cfg: VideoFeederConfig): VideoClip[] {
  return [...clips]
    .filter((c) => { const views = readSourceCount(c.views); return views !== null && views >= cfg.nicheTrending.minViews; })
    .sort((a, b) => b.views! - a.views!)
    .slice(0, cfg.nicheTrending.n);
}

/**
 * The counts behind a lane's kept set — what fell out and why. Powers the
 * harvest console's "kept:0 · below min-views 30" line so a too-strict filter
 * reads differently from a bad pull. `offObjective` is filled by the tick after
 * grading (this pre-grade stage never sees the objective).
 */
export interface LaneDrops {
  belowMinViews: number;
  notSelected: number;
}
export interface LaneSelection {
  selected: VideoClip[];
  dropped: LaneDrops;
}

/** Creator lane + drop attribution: everything the union didn't pick is notSelected. */
export function selectCreatorWithReasons(clips: VideoClip[], cfg: VideoFeederConfig): LaneSelection {
  const selected = selectCreatorClips(clips, cfg);
  return { selected, dropped: { belowMinViews: 0, notSelected: clips.length - selected.length } };
}

/**
 * Niche lane + drop attribution: clips under the min-views floor are
 * `belowMinViews`; unknown view counts and clips that lost the top-N cut are
 * `notSelected`. Together they explain every pulled-but-not-kept clip.
 */
export function selectNicheWithReasons(clips: VideoClip[], cfg: VideoFeederConfig): LaneSelection {
  const belowMinViews = clips.filter((c) => { const views = readSourceCount(c.views); return views !== null && views < cfg.nicheTrending.minViews; }).length;
  const selected = selectNicheClips(clips, cfg);
  return { selected, dropped: { belowMinViews, notSelected: clips.length - belowMinViews - selected.length } };
}

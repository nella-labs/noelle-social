import { measuredSourceRatio } from "@noelle/runtime/source-values";

/** Observed views divided by captured followers; unknown inputs retain unknown. */
export function reachMultiple(views: number | null, followerCount: number | null | undefined): number | null {
  return measuredSourceRatio(views, followerCount);
}

/** Compact label for a reach multiple, e.g. 2.3 → "2.3×", 0.08 → "0.08×". */
export function fmtReach(multiple: number): string {
  if (multiple >= 10) return `${Math.round(multiple)}×`;
  if (multiple >= 1) return `${multiple.toFixed(1)}×`;
  return `${multiple.toFixed(2)}×`;
}

/**
 * Tone bucket for a reach multiple — drives the badge colour so a glance tells
 * you the magnitude of the measured view/follower comparison.
 * Existing bucket names retain the shared badge styling contract.
 */
export function reachTone(multiple: number): "strong" | "solid" | "audience" {
  if (multiple >= 1) return "strong";
  if (multiple >= 0.3) return "solid";
  return "audience";
}

/** Human one-liner explaining the multiple — used as a tooltip/title. */
export function reachTitle(multiple: number, views: number, followers: number): string {
  const v = views.toLocaleString("en-US");
  const f = followers.toLocaleString("en-US");
  const m = fmtReach(multiple);
  return `${v} recorded views ÷ ${f} captured followers = ${m}.`;
}

import type { Rng } from "../lib/rng.js";
import { pickEngagement, type EngagementKind } from "../lib/engagement.js";

export type Rect = { x: number; y: number; width: number; height: number };

// A located element carries its rect (for the Gaussian click point + Fitts W).
// Older message shapes / fallbacks may only have x,y — wrap them in a tiny rect
// so the click primitive always has a box to sample. Twin of index.ts's rectFrom
// (kept local so the orchestration is unit-testable without chrome.*).
export function rectFrom(loc: { rect?: Rect; x?: number; y?: number }): Rect {
  if (loc.rect && loc.rect.width > 0 && loc.rect.height > 0) return loc.rect;
  const x = loc.x ?? 0;
  const y = loc.y ?? 0;
  return { x: x - 2, y: y - 2, width: 4, height: 4 };
}

export interface EngageLocate {
  ok: boolean;
  x?: number;
  y?: number;
  rect?: Rect;
  /** needsMenu (new Reddit ⇒ the returned rect OPENS the overflow menu), plus the
   *  observed post id/subreddit for the activity event. */
  observed?: { needsMenu?: boolean; post_id?: string; subreddit?: string };
}

/** What the plain-upvote primitive (doUpvote) reports back. */
export interface UpvoteOutcome {
  ok: boolean;
  post_id?: string;
  subreddit?: string;
}

/** The engagement actually landed (or ok:false when NOTHING landed — the caller
 *  records no engagement and must NOT consume the budget). `engagement` names the
 *  kind for the activity event / panel string. SAVE-ONLY: never "downvote". */
export interface EngageResult {
  ok: boolean;
  engagement?: EngagementKind;
  post_id?: string;
  subreddit?: string;
}

/**
 * The primitives engageWithVariety drives, injected so the orchestration — and
 * specifically its FALL-BACK-TO-UPVOTE + Escape-dismiss discipline — is
 * unit-testable without chrome.* (only the index.ts wiring touches CDP):
 *  - upvote: the plain idle-UPVOTE (doUpvote) — locate a feed post, read, click
 *    its upvote arrow. Used BOTH for the 'upvote' draw AND as the universal
 *    FALL-BACK when a save can't be completed. doUpvote re-locates from scratch,
 *    so it is always safe to call after a save attempt scrolled the feed / opened
 *    a menu — no stale-rect hazard on the fallback.
 *  - locateSave: locate the save affordance on a not-already-saved feed post. New
 *    Reddit ⇒ the overflow "…" menu OPENER (observed.needsMenu=true); old Reddit
 *    ⇒ the direct `.save-button` (observed.needsMenu=false). observed carries
 *    post_id + subreddit. Null when nothing saveable is in view.
 *  - locateSaveItem: locate the "Save" item inside the OPEN overflow menu (new
 *    Reddit two-step). Never scrolls (a scroll dismisses the menu). Null when the
 *    menu isn't open / the item drifted.
 *  - click: trusted CDP moveAndClick on a rect (viewport coordinates).
 *  - dismissMenu: close an opened overflow menu without clicking through it
 *    (Escape via CDP) so a failed save never leaves a menu open.
 */
export interface EngageDeps {
  upvote(): Promise<UpvoteOutcome>;
  locateSave(): Promise<EngageLocate | null>;
  locateSaveItem(): Promise<EngageLocate | null>;
  click(rect: Rect): Promise<void>;
  dismissMenu(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** The plain-upvote path, shaped as an EngageResult. Shared by the 'upvote' draw
 *  and every save fall-back so the "engagement is never lost" guarantee has ONE
 *  implementation. A dep throw collapses to ok:false (nothing landed). */
async function upvoteResult(deps: EngageDeps): Promise<EngageResult> {
  const up = await deps.upvote().catch(() => ({ ok: false }) as UpvoteOutcome);
  return up.ok
    ? { ok: true, engagement: "upvote", post_id: up.post_id, subreddit: up.subreddit }
    : { ok: false };
}

/**
 * Deliver ONE idle engagement to the feed, WITH VARIETY: most often a plain
 * upvote (the arrow), but per the weighted mix (`weights`, DEFAULT-OFF ⇒ always
 * upvote until the operator opts in) sometimes a post-SAVE. Returns the
 * engagement actually landed (or ok:false when nothing landed).
 *
 * FALL-BACK-TO-UPVOTE (the load-bearing safety property): ANY save-find/click
 * miss lands the plain upvote instead, so the idle engagement is NEVER lost —
 * and because doUpvote re-locates from scratch, the fallback carries no stale-rect
 * hazard even after the save attempt scrolled the feed or opened a menu. If a
 * save opened the overflow menu but the Save item never resolved, the menu is
 * Escape-dismissed BEFORE the fallback so it is never left open. SAVE-ONLY — the
 * only non-upvote this can deliver is a save; there is no downvote path.
 *
 * The caller keeps canUpvote + ensureOnFeedForUpvote as the shared gate around
 * this call, so a save consumes the SAME rolling-15-min budget + min-gap as an
 * upvote (no extra velocity, no second budget). Idle-only, exactly like an upvote.
 */
export async function engageWithVariety(
  weights: Partial<Record<EngagementKind, number>> | undefined,
  rng: Rng,
  deps: EngageDeps,
): Promise<EngageResult> {
  const kind = pickEngagement(rng, weights);
  if (kind === "upvote") return upvoteResult(deps);

  // kind === "save".
  const target = await deps.locateSave().catch(() => null);
  if (!target?.ok || target.x == null) {
    // Nothing saveable located AND no menu opened yet — the feed hasn't moved, so
    // fall straight back to a plain upvote (the engagement is never lost).
    return upvoteResult(deps);
  }
  const post_id = target.observed?.post_id;
  const subreddit = target.observed?.subreddit;

  // Click the save affordance. New Reddit: this OPENS the overflow menu. Old
  // Reddit: this directly SAVES (needsMenu=false) — one click, done.
  await deps.click(rectFrom(target));
  if (target.observed?.needsMenu !== true) {
    return { ok: true, engagement: "save", post_id, subreddit };
  }

  // New Reddit two-step: give the menu a beat to open, then locate + click the
  // "Save" item. Re-read the item's rect immediately before clicking it (the
  // locate returns a fresh rect; we never reuse a pre-open one).
  await deps.sleep(rng.float(220, 520));
  const item = await deps.locateSaveItem().catch(() => null);
  if (item?.ok && item.x != null) {
    await deps.click(rectFrom(item));
    return { ok: true, engagement: "save", post_id, subreddit };
  }

  // The Save item never opened / drifted. The overflow menu may still be open
  // (its backdrop swallows a click-through), so Escape-dismiss it WITHOUT clicking
  // through, then fall back to a plain upvote — the engagement is never lost, and
  // no open menu is left behind.
  await deps.dismissMenu().catch(() => {});
  return upvoteResult(deps);
}

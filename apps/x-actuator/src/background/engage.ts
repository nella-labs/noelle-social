import type { Rng } from "../lib/rng.js";
import { pickEngagement, type EngagementKind } from "../lib/engagement.js";

export type Rect = { x: number; y: number; width: number; height: number };

// A located element carries its rect (for the Gaussian click point + Fitts W).
// Older message shapes / fallbacks may only have x,y — wrap them in a tiny rect
// so the click primitive always has a box to sample.
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
}

/**
 * The primitives reactWithVariety drives, injected so the orchestration — and
 * specifically its stale-rect discipline — is unit-testable without chrome.*:
 *  - click: trusted CDP moveAndClick on a rect (viewport coordinates).
 *  - locateEngagement: content-script locate of an action-bar button ("like" /
 *    "bookmark" / "retweet") on a SPECIFIC tweet by id. On a hit the content
 *    script scrollIntoViews the tweet first, so the returned rect is FRESH and
 *    every rect measured BEFORE the call is stale. On a miss it returns before
 *    scrolling — the page has not moved.
 *  - locateRepostConfirm: locate the "Repost" item in the transient confirm menu
 *    (never scrolls — a scroll would dismiss the menu).
 *  - dismissMenu: close the open repost menu without clicking through it
 *    (Escape via CDP — the menu's backdrop swallows synthetic clicks).
 */
export interface EngageDeps {
  click(rect: Rect): Promise<void>;
  locateEngagement(kind: EngagementKind, tweetId: string | null): Promise<EngageLocate | null>;
  locateRepostConfirm(): Promise<EngageLocate | null>;
  dismissMenu(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/**
 * Deliver an engagement to the located tweet, WITH VARIETY: most often a plain
 * Like (the ❤ heart at `likeRect`), but per the weighted mix (`weights`,
 * DEFAULT-OFF ⇒ always Like until the operator opts in) sometimes a bookmark or
 * a repost. Returns the engagement actually landed, or null when NOTHING landed
 * (the caller must record a skip and must NOT count a like).
 *
 * Stale-rect contract (the load-bearing safety property): `likeRect` was
 * measured before this call, and locateEngagement scrollIntoViews the tweet on
 * a hit — so after ANY successful engagement-locate the page has scrolled and
 * `likeRect` is dead. From that point on we only ever click freshly-located
 * rects; if the fallback re-locate misses too we deliver nothing rather than
 * fire a trusted CDP click at stale viewport coordinates on a live x.com page
 * (which could hit a link/follow/reply of a DIFFERENT tweet). The pre-locate
 * miss path (locator returned before scrolling) is the only one where the
 * original `likeRect` is still valid, and the only one that reuses it.
 */
export async function reactWithVariety(
  likeRect: Rect,
  tweetId: string | null,
  weights: Partial<Record<EngagementKind, number>> | undefined,
  rng: Rng,
  deps: EngageDeps,
): Promise<EngagementKind | null> {
  const kind = pickEngagement(rng, weights);
  if (kind === "like") {
    await deps.click(likeRect);
    return "like";
  }

  let r: EngageLocate | null;
  try {
    r = await deps.locateEngagement(kind, tweetId);
  } catch {
    // The content script may have scrolled before its response was lost.
    return null;
  }
  if (!r) return null;
  if (r.ok === false) {
    // Confirmed miss ⇒ locateEngagement returned BEFORE its scrollIntoView, so
    // the page hasn't moved since likeRect was measured — falling back to a
    // plain Like on the original rect is still safe (never costs the like).
    await deps.click(likeRect);
    return "like";
  }
  if (r.ok !== true || r.x == null || r.y == null) return null;
  await deps.click(rectFrom(r));
  if (kind === "bookmark") return "bookmark";

  // repost: a two-step confirm. Give the menu a beat to open, then click Repost.
  await deps.sleep(rng.float(220, 520));
  const c = await deps.locateRepostConfirm().catch(() => null);
  if (c?.ok && c.x != null) {
    await deps.click(rectFrom(c));
    return "repost";
  }

  // Confirm never opened / drifted. The repost menu may still be open (its
  // backdrop swallows click-through) and locateEngagement scrolled the tweet,
  // so likeRect is STALE. Dismiss the menu without clicking (Escape), then
  // re-locate the like button on the SAME tweet for a FRESH rect. If that
  // misses too, deliver nothing — the caller records a skip. Never a blind
  // stale-rect click, never a phantom like count.
  await deps.dismissMenu().catch(() => {});
  await deps.sleep(rng.float(250, 600));
  const fresh = await deps.locateEngagement("like", tweetId).catch(() => null);
  if (fresh?.ok && fresh.x != null) {
    await deps.click(rectFrom(fresh));
    return "like";
  }
  return null;
}

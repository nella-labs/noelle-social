import type { Rng } from "../lib/rng.js";
import type { Cdp } from "./cdp.js";
import type { LocateResult } from "../content/locators.js";
import { readingDwellMs } from "../lib/dwell.js";
import { isXPageUrl } from "./tab-guard.js";

export type AmbientKind = "scroll" | "expand" | "comments" | "navigate";

export interface AmbientChoiceCtx {
  /**
   * When false (the read-action cooldown has not yet elapsed, or read actions
   * are disabled), only scroll.
   */
  readActionsAllowed?: boolean;
}

/**
 * Idle reading stays on the feed. Targeted X discovery is selected separately
 * by the caller, so a random idle choice cannot open comments or other pages.
 */
export function chooseAmbient(rng: Rng, ctx: AmbientChoiceCtx = {}): AmbientKind {
  return ctx.readActionsAllowed && rng.next() < 0.45 ? "expand" : "scroll";
}

/**
 * Decide whether to slip a LIKE into the idle wait between scheduled actions.
 * Pure so the gating is unit-testable; the actual DOM like runs in the background.
 * Gated four ways:
 *  - quiet gap: never while `inQuietGap` — a drain gap whose pattern scheduled
 *    zero likes (the cooldown pattern, scheduler.inQuietDrainGap). Idle-liking
 *    through it would fill the pause the plan chose to leave empty; the ambient
 *    browse alone keeps the session alive. Without this the cooldown pattern is
 *    cosmetic — the pattern layer frees like-budget headroom that idle-likes
 *    would otherwise spend refilling the quiet gaps.
 *  - budget: only while `doneLikes < targetLikes`, so idle likes fill toward — and
 *    never exceed — the session's like budget (already clamped to the daily cap).
 *  - curfew: never while `inCurfew` (the shared write-curfew gate, ../lib/curfew).
 *  - pace: no more often than `minGapMs`, so waiting-gap likes cluster like a
 *    human instead of firing on every ~4s idle tick.
 */
export function shouldIdleLike(args: {
  doneLikes: number;
  targetLikes: number;
  inCurfew: boolean;
  sinceLastIdleLikeMs: number;
  minGapMs: number;
  inQuietGap?: boolean;
  /**
   * True while a drain is running. A drain gap takes ONLY the like slots its
   * plan scheduled: idle-liking cannot exceed the like budget, but it RACES
   * AHEAD of it on a flat ~45-81s drip, which flattens the per-gap patterns
   * (#471) back into the single uniform cadence they exist to break — and the
   * plan's later slots are then skipped as budget-met. Ported from Lyra #497.
   */
  inDrain?: boolean;
}): boolean {
  if (args.inDrain) return false;
  if (args.inQuietGap) return false;
  if (args.doneLikes >= args.targetLikes) return false;
  if (args.inCurfew) return false;
  return args.sinceLastIdleLikeMs >= args.minGapMs;
}

/** Reserve before POST; release only slots the server confirms were not new leads. */
export async function submitObservationBatch<T>(
  batch: T[],
  budget: { remaining: number },
  post: (items: T[]) => Promise<{ accepted: number; duplicates: number; invalid: number }>,
): Promise<number> {
  if (batch.length > budget.remaining) throw new Error("X observation batch exceeds capacity");
  const before = budget.remaining;
  budget.remaining -= batch.length;
  const result = await post(batch);
  if (![result.accepted, result.duplicates, result.invalid].every((count) => Number.isSafeInteger(count) && count >= 0)
      || result.accepted + result.duplicates + result.invalid !== batch.length) {
    throw new Error("invalid X observation acknowledgement");
  }
  budget.remaining = Math.min(before, budget.remaining + result.duplicates + result.invalid);
  return result.accepted;
}

const FEED = "https://x.com/home";

type Sleep = (ms: number) => Promise<void>;
type Send = <T>(tabId: number, msg: unknown) => Promise<T>;

export interface AmbientDeps {
  cdp: Pick<Cdp, "wheel">;
  /** Trusted actor click with child-tab containment. */
  click: (tabId: number, rect: { x: number; y: number; width: number; height: number }) => Promise<void>;
  rng: Rng;
  sleep: Sleep;
  /** Background→content message bridge (chrome.tabs.sendMessage wrapper). */
  send: Send;
  /** This session's reading pace, for dwell timing. */
  wpm: number;
  /**
   * Navigate for an explicit X discovery target. The injected helper clears
   * any leftover composer before moving the pinned tab.
   */
  navigate: (tabId: number, url: string) => Promise<void>;
  /** Explicit in-interest X target, selected by browser discovery only. */
  navigationTarget?: string;
  /** Broader version of a keyword search, used only after two reads accept no new posts. */
  emptySearchFallbackTarget?: string;
  /** Confirmed server intake, distinct from cards visible in the browser. Void means the read failed. */
  onPageRead?: (tabId: number) => Promise<{ visible: number; accepted: number } | void>;
  /** Recheck the observation budget after the first target read. */
  canReadMore?: () => boolean | Promise<boolean>;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A trusted-click rect from a locate result (mirrors index.ts rectFrom). */
function rectOf(loc: LocateResult): { x: number; y: number; width: number; height: number } {
  if (loc.rect && loc.rect.width > 0 && loc.rect.height > 0) return loc.rect;
  const x = loc.x ?? 0;
  const y = loc.y ?? 0;
  return { x: x - 2, y: y - 2, width: 4, height: 4 };
}

/**
 * A right-skewed pause / scroll magnitude: a hard human `floor` plus a
 * gamma-tailed body, clamped to a human `cap`. gamma(k=2) is unimodal and
 * right-skewed, so most draws sit a little above the floor with an occasional
 * long "distraction" tail — far less fingerprintable than a flat uniform range,
 * whose exact min and max are constants an analyst can read straight off a
 * session. `body` is the mean distance above the floor (theta = body/2 ⇒
 * mean = floor + body). Unit-agnostic: used for both ms dwells and px scrolls.
 */
function skew(rng: Rng, floor: number, body: number, cap: number): number {
  return Math.round(Math.min(cap, floor + rng.gamma(2, body / 2)));
}

async function scrollAndDwell(tabId: number, deps: Pick<AmbientDeps, "cdp" | "rng" | "sleep">): Promise<void> {
  const { cdp, rng, sleep } = deps;
  await cdp.wheel(tabId, { x: 400, y: 400 }, skew(rng, 600, 780, 2800), rng, sleep);
  // A right-skewed pause plus an occasional long distraction keeps scrolls
  // paced the same way on the feed and during a keyword-search visit.
  let dwell = 1500 + rng.gamma(2, 1300);
  if (rng.next() < 0.08) dwell += rng.float(4000, 15000);
  await sleep(Math.round(Math.min(20000, dwell)));
}

/**
 * Run one ambient behavior. Returns what it ACTUALLY did — "expand"
 * downgrades to "scroll" when nothing suitable is in view — so the caller paces
 * the read-action cooldown off real actions, not attempts.
 */
export async function runAmbient(
  tabId: number,
  kind: AmbientKind,
  deps: AmbientDeps,
): Promise<AmbientKind> {
  const { click, rng, sleep, send, wpm, navigate } = deps;

  // Expand a truncated post and read the fuller text.
  if (kind === "expand") {
    const loc = await send<LocateResult>(tabId, { cmd: "locateAmbientExpand" }).catch(() => null);
    if (loc?.ok) {
      await click(tabId, rectOf(loc));
      await sleep(skew(rng, 320, 260, 1800)); // let the fuller text lay out (~580ms, right-skewed)
      // Fuller text is visible now → a longer read, proportional to the post.
      // Random inflation (mean ~2.7×, was a fixed 2.2×) widens how much "fuller"
      // text we model reading, so the dwell isn't pinned to one constant ratio.
      const wc = Math.round(num(loc.observed?.wordCount, 60) * rng.float(2.0, 3.4));
      await sleep(readingDwellMs(rng, wc, { hasMedia: loc.observed?.hasMedia === true }, wpm));
      return "expand";
    }
    kind = "scroll"; // nothing to expand in view → scroll on
  }

  // Legacy/stale actions must also stay on the feed.
  if (kind === "comments" || (kind === "navigate" && !isXPageUrl(deps.navigationTarget))) kind = "scroll";

  if (kind === "scroll") {
    await scrollAndDwell(tabId, deps);
    return "scroll";
  }

  // Purposeful browser discovery visits a watched X profile or keyword search.
  const target = deps.navigationTarget!;
  const fallbackTarget = deps.emptySearchFallbackTarget;
  const onPageRead = deps.onPageRead;
  const canReadMore = deps.canReadMore;
  try {
    await navigate(tabId, target);
    await sleep(skew(rng, 4000, 5200, 22000)); // dwell on the target
    const firstRead = await onPageRead?.(tabId);
    let acceptedPosts = firstRead?.accepted ?? 0;
    let readsSucceeded = firstRead !== undefined;
    if (new URL(target).pathname === "/search" && onPageRead && canReadMore && await canReadMore()) {
      await scrollAndDwell(tabId, deps);
      if (await canReadMore()) {
        const secondRead = await onPageRead(tabId);
        acceptedPosts += secondRead?.accepted ?? 0;
        readsSucceeded &&= secondRead !== undefined;
      }

import type { Rng } from "../lib/rng.js";
import type { Cdp } from "./cdp.js";
import type { LocateResult } from "../content/locators.js";
import { readingDwellMs } from "../lib/dwell.js";

export type AmbientKind = "scroll" | "expand" | "comments" | "navigate";

export interface AmbientChoiceCtx {
  /**
   * When false (the read-action cooldown has not yet elapsed, or read actions
   * are disabled), only scroll/navigate — the original idle behavior.
   */
  readActionsAllowed?: boolean;
}

/**
 * Pick the next idle behavior. Scroll dominates; "expand" (open "…more") and
 * "comments" (open the thread to read) are the read-only decoys that make the
 * session look like a human actually reading the feed — but they only surface
 * when `readActionsAllowed`, so the caller can rate-limit them into natural
 * clusters instead of firing every ~4s tick.
 *
 * The no-context path is byte-identical to the original (navigate 12% / scroll)
 * so idle liveness is unchanged when read actions are on cooldown.
 */
export function chooseAmbient(rng: Rng, ctx: AmbientChoiceCtx = {}): AmbientKind {
  if (ctx.readActionsAllowed) {
    // Per-tick jitter on the blend so the idle mix is NOT a fixed 34/20/6/40
    // every time: expand still dominates and navigate stays rare, but the exact
    // split wanders tick to tick (and, across seeds, session to session), so
    // repeated runs don't share one hard decision boundary at r=0.34/0.54/0.60.
    // All four are read-only decoys, so the long-run rate of read-clicks is
    // unchanged — only its spread widens (never faster/burstier).
    const weights = [
      0.34 * rng.float(0.78, 1.26), // expand — the dominant read-action
      0.2 * rng.float(0.72, 1.32),  // comments
      0.06 * rng.float(0.6, 1.5),   // navigate — stays rare
      0.4 * rng.float(0.82, 1.2),   // scroll
    ];
    return (["expand", "comments", "navigate", "scroll"] as const)[
      rng.pickWeighted(weights)
    ]!;
  }
  return rng.next() < 0.12 ? "navigate" : "scroll";
}

/**
 * Decide whether to slip a LIKE into the idle wait between scheduled actions.
 * Pure so the gating is unit-testable; the actual DOM like runs in the background.
 * Gated five ways (in the order the code checks them):
 *  - drain: never while `inDrain` — a drain gap takes ONLY the like slots its
 *    pattern planned. The idle top-up used to share the plan's budget and race
 *    ahead of it (a like every ~45-80s of waiting), stacking up to ~10 likes
 *    before a reply; since 2026-07-23 the operator wants that wait visibly
 *    IDLE — the ambient browse alone keeps the session looking alive.
 *  - quiet gap: never while `inQuietGap` — a drain gap whose pattern scheduled
 *    zero likes (scheduler.inQuietDrainGap). Subsumed by the drain gate today;
 *    kept as defense in depth should drain idle-likes ever return.
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
  inDrain?: boolean;
}): boolean {
  if (args.inDrain) return false;
  if (args.inQuietGap) return false;
  if (args.doneLikes >= args.targetLikes) return false;
  if (args.inCurfew) return false;
  return args.sinceLastIdleLikeMs >= args.minGapMs;
}

const FEED = "https://www.linkedin.com/feed/";
const NAV_TARGETS = ["https://www.linkedin.com/notifications/", "https://www.linkedin.com/mynetwork/"];

type Sleep = (ms: number) => Promise<void>;
type Send = <T>(tabId: number, msg: unknown) => Promise<T>;

export interface AmbientDeps {
  cdp: Cdp;
  rng: Rng;
  sleep: Sleep;
  /** Background→content message bridge (chrome.tabs.sendMessage wrapper). */
  send: Send;
  /** This session's reading pace, for dwell timing. */
  wpm: number;
  /**
   * Navigate the tab. Injected rather than calling `chrome.tabs.update` here so
   * the ambient hop clears the composer first, like every other navigation this
   * actuator makes. Ambient runs BETWEEN actions, so it is the navigation most
   * likely to follow a reply that left text in the box — which is exactly what
   * raises "Leave site? Changes you made may not be saved." and wedges the run.
   */
  navigate: (tabId: number, url: string) => Promise<void>;
  /** Replaces only this already-planned navigation destination. */
  navigationTarget?: string;
  /** Read the visited page while it is still open, before the return hop. */
  onPageRead?: (tabId: number) => Promise<void>;
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

/**
 * Run one ambient behavior. Returns what it ACTUALLY did — "expand"/"comments"
 * downgrade to "scroll" when nothing suitable is in view — so the caller paces
 * the read-action cooldown off real actions, not attempts.
 */
export async function runAmbient(
  tabId: number,
  kind: AmbientKind,
  deps: AmbientDeps,
): Promise<AmbientKind> {
  const { cdp, rng, sleep, send, wpm, navigate } = deps;

  // Expand a truncated post and read the fuller text.
  if (kind === "expand") {
    const loc = await send<LocateResult>(tabId, { cmd: "locateAmbientExpand" }).catch(() => null);
    if (loc?.ok) {
      await cdp.moveAndClick(tabId, rectOf(loc), rng, sleep);
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

  // Open a post's comments and read the discussion (a small scroll + dwell).
  if (kind === "comments") {
    const loc = await send<LocateResult>(tabId, { cmd: "locateAmbientComments" }).catch(() => null);
    if (loc?.ok) {
      await cdp.moveAndClick(tabId, rectOf(loc), rng, sleep); // open the thread
      await sleep(skew(rng, 720, 720, 3400)); // comments fetch + render (~1.44s, occasional slow load)
      await cdp.wheel(tabId, { x: 400, y: 480 }, skew(rng, 220, 340, 1000), rng, sleep);
      // Comment-body word count: wider spread (mean ~52, sd 28, was 45/18) so the
      // reading dwell it feeds varies more thread to thread.
      await sleep(readingDwellMs(rng, Math.max(0, Math.round(rng.normal(52, 28))), {}, wpm));
      return "comments";
    }
    kind = "scroll";
  }

  if (kind === "scroll") {
    await cdp.wheel(tabId, { x: 400, y: 400 }, skew(rng, 600, 780, 2800), rng, sleep);
    // Dwell/read: a right-skewed body plus an occasional heavy-tail "distraction"
    // pause, so the between-scroll gap isn't a flat [1500,6000] every time. The
    // floor stays 1500 and the mean drifts slightly SLOWER (never faster); ~8% of
    // the time the reader wanders off for several extra seconds.
    let dwell = 1500 + rng.gamma(2, 1300); // floor 1500, mean ~4.1s
    if (rng.next() < 0.08) dwell += rng.float(4000, 15000); // got distracted
    await sleep(Math.round(Math.min(20000, dwell)));
    return "scroll";
  }

  // navigate-away-and-back (rare)
  const target = deps.navigationTarget ?? NAV_TARGETS[rng.int(0, NAV_TARGETS.length - 1)]!;
  await navigate(tabId, target);
  await sleep(skew(rng, 4000, 5200, 22000)); // dwell on the other page (~9.2s, occasional long browse)
  if (deps.navigationTarget) await deps.onPageRead?.(tabId);
  await navigate(tabId, FEED);
  await sleep(skew(rng, 2000, 2200, 9000)); // settle back on the feed (~4.2s)
  return "navigate";
}

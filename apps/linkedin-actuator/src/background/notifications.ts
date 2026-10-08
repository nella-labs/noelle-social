import { NOTIFICATIONS_ACTOR_ENABLED } from "../lib/notifications-feature.js";
// The notifications actor — "part 2" of the reply system, LinkedIn side.
//
// Lyra comments on people's posts; when they reply, the thread dies on our
// side. This sweep reads the notifications page, keeps the cards that say
// somebody replied to something of OURS, and POSTs them to api-vm as leads.
// Lyra's drafter picks them up, the approval lands in the normal queue, and the
// SAME live run comments it.
//
// Known limitation (deliberate, documented in the design spec): the LinkedIn
// actuator's comment box is post-scoped, so the answer lands as a comment on
// the post addressed to the person by name, not threaded under their comment.
// Comment-level threading needs new locators and is the riskier surface on the
// platform that fingerprints hardest.
//
// Nothing here writes to linkedin.com. It navigates, reads, and reports.

import type { Rng } from "../lib/rng.js";
import type { ActuatorApi } from "../lib/api.js";
import type { InboundReplyItem } from "@noelle/contracts";
import {
  MAX_AGE_MINUTES,
  ageBuckets,
  selectRepliesToMe,
  type HarvestedNotification,
} from "../content/notifications.js";
import { readingDwellMs } from "../lib/dwell.js";
import type { Cdp } from "./cdp.js";

export const NOTIFICATIONS_URL = "https://www.linkedin.com/notifications/";

/** chrome.storage.local key for the already-ingested ring. */
export const SEEN_KEY = "actuator.seenNotifications";
/** How many notification ids to remember locally. */
export const SEEN_CAP = 500;
/** Most notifications ingested per sweep — see the X twin for the reasoning. */
export const MAX_PER_SWEEP = 3;
/** Floor between sweeps; the caller jitters it into roughly 10-20 minutes. */
export const SWEEP_MIN_GAP_MS = 10 * 60_000;

/**
 * Whether this idle tick should sweep the notifications page instead of
 * ambient-browsing. Pure so the cadence is unit-testable. Not gated on the
 * write curfew: harvesting is read-only, and having overnight replies drafted
 * and ready at 9am beats waking up to a cold queue.
 */
export function notificationSweepDue(args: {
  enabled: boolean;
  sinceLastSweepMs: number;
  minGapMs: number;
}): boolean {
  // Kill switch first, before any other consideration. The sweep is what FILES
  // conversation leads, so stopping it here is the real stop — nothing
  // downstream can create work. See lib/notifications-feature.ts.
  if (!NOTIFICATIONS_ACTOR_ENABLED) return false;
  if (!args.enabled) return false;
  return args.sinceLastSweepMs >= args.minGapMs;
}

/** What a run does with an idle tick (no action due). */
export type IdleActivity = "sweep" | "quiet" | "like" | "browse";

/**
 * Choose the idle behavior. Pure, because the ORDER here is load-bearing and
 * was wrong once: the sweep must be decided BEFORE the supply gate.
 *
 * The supply gate ("both pools empty ⇒ go quiet, no likes, no browsing") exists
 * so a run whose pipeline ran dry stops burning engagement. But the
 * notifications sweep is the thing that CREATES this run's supply. Gating it on
 * "we already have something to send" deadlocks the entire feature in its most
 * common starting state: you click Auto notifications with an empty approval
 * queue → pools are empty → gate fires → no sweep → no leads → no approvals →
 * pools stay empty, forever. The run would sit on "nothing to send" and never
 * check a single notification.
 *
 * So: sweep first, and only then the quiet gate.
 */
export function chooseIdleActivity(args: {
  sweepDue: boolean;
  pipelineDry: boolean;
  idleLike: boolean;
}): IdleActivity {
  if (args.sweepDue) return "sweep"; // the sweep IS the supply — never gate it on supply
  if (args.pipelineDry) return "quiet";
  return args.idleLike ? "like" : "browse";
}

/**
 * Fold newly-ingested ids into the seen ring, newest first, capped. Pure. The
 * ring is only a cheap first gate — the server's UNIQUE(external_id) is the
 * real idempotency — so dropping the tail is safe.
 */
export function mergeSeen(seen: readonly string[], ids: readonly string[], cap: number): string[] {
  const out: string[] = [];
  const dedup = new Set<string>();
  for (const id of [...ids, ...seen]) {
    if (dedup.has(id)) continue;
    dedup.add(id);
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Build the API item for one harvested reply. Pure.
 *
 * `posted_at` is the sweep time, not the comment's: LinkedIn cards render
 * relative ages ("3h") with no machine-readable timestamp. The field feeds the
 * reply-freshness ceiling, and a notification we just saw is fresh by
 * construction, so stamping now is both honest and correct for that use.
 */
/**
 * The contract caps scraped text at 4000 chars, and the server parses a sweep
 * as ONE batch — so a single over-long field would 400 the whole request and
 * lose every other item with it. LinkedIn comments run long. Clamp at the
 * source; the drafter needs the gist, and the ellipsis tells it the text was cut.
 */
export const MAX_TEXT = 4000;
export function clampText(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

export function toInboundItem(item: HarvestedNotification, nowIso: string): InboundReplyItem {
  return {
    external_id: item.external_id,
    author_handle: item.public_id,
    text: clampText(item.text),
    url: item.url,
    posted_at: nowIso,
    // The card quotes the original post underneath the comment, so the drafter
    // gets real thread context for free — no extra navigation.
    ...(item.activity_urn || item.post_context
      ? {
          conversation: {
            ...(item.activity_urn ? { root_post_id: item.activity_urn } : {}),
            ...(item.post_context ? { root_post_text: clampText(item.post_context) } : {}),
          },
        }
      : {}),
  };
}

type Sleep = (ms: number) => Promise<void>;
type Send = <T>(tabId: number, msg: unknown) => Promise<T>;

export interface SweepDeps {
  cdp: Cdp;
  rng: Rng;
  sleep: Sleep;
  send: Send;
  api: ActuatorApi;
  instanceId: string;
  wpm: number;
  navigate: (tabId: number, url: string) => Promise<void>;
  stopped: () => boolean;
}

export interface SweepOutcome {
  /** Cards the page rendered at all — distinguishes "nothing new" from "the
   * page gave us nothing", which look identical from the panel. */
  harvested?: number;
  fresh: number;
  accepted: number;
  skipped: number;
  detail?: string;
}

/**
 * One notifications sweep. Navigates to the notifications page, reads it,
 * POSTs up to MAX_PER_SWEEP new replies, and returns to the feed. Every step is
 * best-effort: a sweep that finds nothing, or breaks on a selector, costs one
 * idle tick and nothing else.
 */
/**
 * Ask the page for its notifications, with retries.
 *
 * Two failure modes were previously collapsed into "there is nothing here":
 *
 *  1. chrome.tabs.update DESTROYS the content script and the browser re-injects
 *     it on the new document. A sendMessage that lands in that window rejects
 *     with "Receiving end does not exist". The old code caught that and
 *     returned [], which the sweep read as an empty inbox.
 *  2. The notifications list renders ASYNC. One fixed sleep after load is a
 *     race — on a slow load the DOM genuinely has no cards yet.
 *
 * Both are transient and both are fixed by asking again. `contacted` reports
 * whether the page ever answered AT ALL, so the caller can say "the page never
 * responded" instead of lying about an empty inbox.
 */
/**
 * Why a sweep ended with nothing to do — or `undefined` when the caller in
 * background/index.ts already phrases it better.
 *
 * Unlike X, `harvestNotifications` here returns ONLY replies-to-us (the card's
 * own `highlightedUpdateType` says so), so every harvested card is a candidate.
 *
 * The distinction that matters is between the three remaining zeroes, which
 * used to render identically. This string is what the panel shows and what
 * lands in noelle.linkedin_activity.reason, so it is the first thing anybody

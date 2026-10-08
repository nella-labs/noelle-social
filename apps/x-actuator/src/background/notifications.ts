import { NOTIFICATIONS_ACTOR_ENABLED } from "../lib/notifications-feature.js";
// The notifications actor — "part 2" of the reply system.
//
// Vega opens conversations and never finishes them: we reply to a stranger's
// post, they reply back, and the thread dies on our side. This sweep reads the
// mentions timeline, keeps the tweets that are replies TO US, opens a couple of
// them to read the thread they belong to, and POSTs them to api-vm as leads.
// Vega's drafter picks them up with full voice grounding, the approval lands in
// the normal queue, and the SAME live run posts it in-thread.
//
// Nothing here writes to x.com. It navigates, reads, and reports.

import type { Rng } from "../lib/rng.js";
import type { ActuatorApi } from "../lib/api.js";
import type { InboundReplyItem } from "@noelle/contracts";
import {
  MAX_AGE_MINUTES,
  ageBuckets,
  conversationFrom,
  isReplyToMe,
  selectRepliesToMe,
  type HarvestedNotification,
  type ThreadTweet,
} from "../content/notifications.js";
import { readingDwellMs } from "../lib/dwell.js";
import type { Cdp } from "./cdp.js";

// The "All" tab, not /notifications/mentions. Real replies to us render there
// as article[data-testid="tweet"] alongside the like/follow cards (which render
// as data-testid="notification" and are ignored), so All sees strictly more.
export const NOTIFICATIONS_URL = "https://x.com/notifications";

/** chrome.storage.local key for the already-ingested ring. */
export const SEEN_KEY = "actuator.seenNotifications";
/** How many notification ids to remember locally. */
export const SEEN_CAP = 500;
/** chrome.storage.local key for the last self-handle a sweep could read. */
export const SELF_HANDLE_KEY = "actuator.selfHandle";
/**
 * Most notifications ingested per sweep. The bound matters twice: it caps how
 * many permalinks we open in one visit (each is a navigation, and a burst of
 * them is the tell), and it stops one busy morning from dumping a whole
 * backlog into the drafting queue.
 */
export const MAX_PER_SWEEP = 3;
/**
 * Floor between sweeps. Jittered by the caller into roughly 10-20 minutes — a
 * human checks their mentions a few times an hour, not every tick.
 */
export const SWEEP_MIN_GAP_MS = 10 * 60_000;

/**
 * Whether this idle tick should sweep the notifications page instead of
 * ambient-browsing. Pure so the cadence is unit-testable.
 *
 * Deliberately NOT gated on the write curfew: harvesting is read-only, and
 * collecting overnight replies so they're drafted and ready to post at 9am is
 * strictly better than waking up to a cold queue. The POSTING of those drafts
 * is what the curfew holds, and that gate lives in the tick.
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
 * Fold newly-ingested ids into the seen ring, newest first, capped. Pure.
 * The ring is only a cheap first gate — the real idempotency is the server's
 * UNIQUE(external_id) — so dropping the tail is safe: a forgotten notification
 * is re-sent and reported `duplicate`.
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
 * Build the API item for one harvested reply. Pure. `posted_at` falls back to
 * now: the field feeds the reply-freshness ceiling, and a notification we just
 * saw is fresh by construction — refusing to ingest it because X didn't render
 * a <time> would silently drop real conversations.
 */
/**
 * The contract caps scraped text at 4000 chars, and the server parses a sweep
 * as ONE batch — so a single over-long field would 400 the whole request and
 * lose every other item with it. X Premium long-form posts run to ~25,000
 * chars and absolutely do appear in replies, so this is a real case, not a
 * theoretical one. Clamp at the source; the drafter needs the gist, not the
 * essay, and the ellipsis tells it the text was cut.
 */
export const MAX_TEXT = 4000;
export function clampText(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

export function toInboundItem(
  item: HarvestedNotification,
  // Non-empty at every call site: runNotificationSweep drops items whose thread
  // it could not read, so the conversation key stays stable across sweeps (see
  // the turn-cap note there). The signature still tolerates [] for tests.
  chain: readonly ThreadTweet[],
  selfHandle: string,
  nowIso: string,
): InboundReplyItem {
  const c = conversationFrom(chain, selfHandle);
  const conversation = {
    ...c,
    ...(c.root_post_text ? { root_post_text: clampText(c.root_post_text) } : {}),
    ...(c.our_reply_text ? { our_reply_text: clampText(c.our_reply_text) } : {}),
  };
  return {
    external_id: item.tweet_id,
    author_handle: item.handle,
    text: clampText(item.text),
    url: item.url,
    posted_at: item.posted_at ?? nowIso,
    ...(Object.keys(conversation).length > 0 ? { conversation } : {}),
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
  /** This session's reading pace, for dwell timing. */
  wpm: number;
  /** Navigate the actuated tab and wait for load (index.ts owns both). */
  navigate: (tabId: number, url: string) => Promise<void>;
  /** True once the run has been stopped/superseded — unwind without acting. */
  stopped: () => boolean;
  /** Operator-configured handle, used only when the DOM read fails. */
  configuredHandle?: string | undefined;
}

export interface SweepOutcome {
  /** Notification cells the page rendered at all. Distinguishes "nothing new"
   * from "the page gave us nothing", which look identical from the panel. */
  harvested?: number;
  /** Reply-to-me cells found that we hadn't already ingested. */
  fresh: number;
  /** Items the server accepted as new leads. */
  accepted: number;
  /** Items the server refused (duplicate / turn-cap). */
  skipped: number;
  /** Set when the sweep couldn't run; the caller logs it to the panel. */
  detail?: string;
}

/**
 * One notifications sweep. Navigates to the mentions tab, reads it, opens up to
 * MAX_PER_SWEEP new replies to capture their thread context, POSTs them, and

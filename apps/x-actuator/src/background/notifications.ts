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
 * returns to the feed. Every step is best-effort: a sweep that finds nothing,
 * or breaks on a selector, costs one idle tick and nothing else.
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
 * Why a sweep ended with nothing to do — or `undefined` when the caller's own
 * wording already says it better.
 *
 * There are five different zeroes here and they used to render identically.
 * Getting this wrong is not cosmetic: this string is what the panel shows and
 * what lands in noelle.x_activity.reason, so it is the thing anybody debugging
 * "Vega answered nothing" reads first. A line that blames the recency window for a
 * seen-ring zero sends them straight at the wrong code.
 *
 * `undefined` for the two cases the caller in background/index.ts already
 * phrases well — nothing harvested at all ("selectors may have drifted", the
 * signal added when a silent page was being reported as an empty inbox) and
 * nothing that was a reply to us ("read N cells, none are new replies to you").
 * Returning a string for those would make both of those branches dead code.
 */
export function describeEmptySweep(args: {
  harvested: number;
  ages: { recent: number; stale: number; undated: number };
}): string | undefined {
  // Derived, never passed in: a caller that disagreed with its own buckets is
  // how the first version printed "3 replies, none within Nh (0 older, 0
  // undated)". Deriving the total makes that line unrepresentable.
  const candidates = args.ages.recent + args.ages.stale + args.ages.undated;
  if (args.harvested === 0) return undefined; // "page rendered NO cells"
  if (candidates === 0) return undefined; // "none are new replies to you"
  const hours = MAX_AGE_MINUTES / 60;
  if (args.ages.undated === candidates) {
    return `no readable timestamp on any of ${candidates} replies — <time> markup may have changed`;
  }
  if (args.ages.recent === 0) {
    return `${candidates} replies, none within ${hours}h (${args.ages.stale} older, ${args.ages.undated} undated)`;
  }
  // Recent ones exist but none survived the seen-ring. The ring records what we
  // INGESTED, not what we answered — a lead can die downstream (triage, a
  // verifier gate, an error) without a single word reaching the person. Saying
  // "handled" there was a claim the sweep cannot support, and it was wrong in
  // practice: "that one that says already handled is not handled".
  return `${args.ages.recent} replies within ${hours}h, all already ingested (nothing new to file)`;
}

async function harvestWithRetry<T>(
  tabId: number,
  send: Send,
  sleep: Sleep,
  attempts = 4,
): Promise<{ items: T[]; contacted: boolean; lastError?: string }> {
  let contacted = false;
  let lastError: string | undefined;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1200 * i); // 1.2s, 2.4s, 3.6s — the list is async
    try {
      const r = await send<{ ok: boolean; items: T[] }>(tabId, { cmd: "harvestNotifications" });
      contacted = true;
      const items = r?.items ?? [];
      // Cards present ⇒ done. Zero on an early attempt is far more likely to be
      // a half-rendered list than a genuinely empty inbox, so keep asking.
      if (items.length > 0) return { items, contacted };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { items: [], contacted, ...(lastError ? { lastError } : {}) };
}

export async function runNotificationSweep(
  tabId: number,
  deps: SweepDeps,
): Promise<SweepOutcome> {
  const { rng, sleep, send, api, cdp, wpm, navigate, stopped } = deps;

  await navigate(tabId, NOTIFICATIONS_URL);
  if (stopped()) return { fresh: 0, accepted: 0, skipped: 0, detail: "stopped" };
  await sleep(rng.float(1200, 2600)); // let the timeline hydrate

  // Resolve WHO WE ARE, in priority order: a live DOM read, then the handle a
  // previous sweep discovered and cached, then the operator's Options value.
  // The cache matters because the DOM read is layout-dependent — X collapses the
  // side nav on a narrow window — and one failed read should not silently
  // disable the whole feature until the next restart.
  const domHandle = await send<{ ok: boolean; handle: string | null }>(tabId, { cmd: "readSelfHandle" })
    .then((r) => r?.handle ?? null)
    .catch(() => null);
  const cached = (await chrome.storage.local.get(SELF_HANDLE_KEY))[SELF_HANDLE_KEY] as string | undefined;
  const selfHandle = domHandle ?? cached ?? deps.configuredHandle ?? null;
  if (domHandle && domHandle !== cached) {
    await chrome.storage.local.set({ [SELF_HANDLE_KEY]: domHandle });
  }
  if (!selfHandle) {
    // Do NOT guess. Say exactly what is wrong and what fixes it — this used to
    // fail as a single grey panel line and looked identical to "nothing to do".
    return {
      fresh: 0, accepted: 0, skipped: 0,
      detail: "cannot tell which account is logged in — set selfHandle in the extension Options",
    };
  }

  // Read the tab like a person: a scroll or two with dwells between.
  const passes = rng.int(1, 2);
  for (let i = 0; i < passes; i++) {
    if (stopped()) break;
    await sleep(readingDwellMs(rng, Math.round(rng.normal(46, 22)), {}, wpm));
    await cdp.wheel(tabId, { x: 400, y: 420 }, Math.round(rng.float(420, 1100)), rng, sleep);
  }

  const probe = await harvestWithRetry<HarvestedNotification>(tabId, send, sleep);
  const harvested = probe.items;
  if (!probe.contacted) {
    // The page never answered. Say so — this used to be reported as an empty
    // inbox, which is the single most misleading thing the sweep could do.
    return {
      fresh: 0, accepted: 0, skipped: 0, harvested: 0,
      detail: `notifications page did not respond${probe.lastError ? ` (${probe.lastError})` : ""} — will retry next sweep`,
    };
  }

  const store = await chrome.storage.local.get(SEEN_KEY);
  const seen = (store[SEEN_KEY] as string[] | undefined) ?? [];
  const fresh = selectRepliesToMe(harvested, { selfHandle, seen, max: MAX_PER_SWEEP });
  if (fresh.length === 0) {
    // Keep the notifications page open when no fresh replies are eligible.
    //
    // Buckets over the CANDIDATES — the cells that are actually somebody
    // replying to us — not over everything harvested. The page is mostly likes,
    // follows and our own tweets; bucketing those would blame the recency
    // window for a zero it had nothing to do with.
    const candidates = harvested.filter((h) => isReplyToMe(h, selfHandle));
    const ages = ageBuckets(candidates, { nowMs: Date.now(), maxAgeMinutes: MAX_AGE_MINUTES });
    const detail = describeEmptySweep({ harvested: harvested.length, ages });
    return {
      fresh: 0,
      accepted: 0,
      skipped: 0,
      harvested: harvested.length,
      ...(detail ? { detail } : {}),
    };
  }

  // Open each one to read the thread it belongs to. A cold reply to a bare
  // fragment reads like a bot; the ancestor chain is what lets the drafter
  // answer the person. Opening a mention is also exactly what a human does.
  const nowIso = new Date().toISOString();
  const items: InboundReplyItem[] = [];
  let noContext = 0;
  for (const item of fresh) {
    if (stopped()) break;
    await navigate(tabId, item.url);
    await sleep(rng.float(900, 2100));
    const chain = await send<{ ok: boolean; chain: ThreadTweet[] }>(tabId, {
      cmd: "harvestThread",
      focusTweetId: item.tweet_id,
    })
      .then((r) => r?.chain ?? [])
      .catch(() => [] as ThreadTweet[]);
    await sleep(readingDwellMs(rng, Math.round(rng.normal(38, 18)), {}, wpm));
    // An unreadable thread is dropped, not filed. Two reasons, both real:
    //  - QUALITY: with no ancestors the drafter is cold-replying to a fragment,
    //    which is the exact bot tell this feature exists to avoid.
    //  - TURN CAP: the conversation key is `root:<id>` when the thread reads and
    //    `author:<handle>` when it doesn't. Filing a context-less item would key
    //    the SAME conversation two different ways across sweeps, so the cap
    //    would count each separately and the thread could run to 2x the limit.
    // Nothing is marked seen here, so the next sweep retries it for free.
    if (chain.length === 0) { noContext++; continue; }
    items.push(toInboundItem(item, chain, selfHandle, nowIso));
  }

  // Back to the notifications page, not the feed — see above.
  await navigate(tabId, NOTIFICATIONS_URL);
  if (items.length === 0) {
    return {
      fresh: fresh.length, accepted: 0, skipped: 0,
      detail: noContext > 0 ? `${noContext} thread(s) unreadable — will retry` : "stopped",
    };
  }

  const res = await api
    .postInboundReplies({ instanceId: deps.instanceId, platform: "x", items })
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }) as const);
  if ("error" in res) {
    return { fresh: fresh.length, accepted: 0, skipped: 0, detail: `ingest-failed: ${res.error}` };

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
 * debugging "Lyra answered nothing" reads. Blaming the recency window for a
 * seen-ring zero — the STEADY STATE, since an answered reply sits on the page
 * for hours and every sweep re-reads it — would be a lie repeated every ten
 * minutes at exactly the moment someone is trying to diagnose something.
 */
export function describeEmptySweep(args: {
  /** Cards the page rendered AT ALL — replies or not. */
  harvested: number;
  ages: { recent: number; stale: number; undated: number };
}): string | undefined {
  // Derived, never passed in: a caller that disagreed with its own buckets is
  // how the first version printed "3 replies, none within Nh (0 older, 0
  // undated)". Deriving the total makes that line unrepresentable.
  const candidates = args.ages.recent + args.ages.stale + args.ages.undated;
  if (args.harvested === 0) return undefined; // "page rendered NO cards"
  if (candidates === 0) return undefined; // "read N cards, none are new replies"
  const hours = MAX_AGE_MINUTES / 60;
  if (args.ages.undated === candidates) {
    return `no readable timestamp on any of ${candidates} replies — time-ago markup may have changed`;
  }
  if (args.ages.recent === 0) {
    return `${candidates} replies, none within ${hours}h (${args.ages.stale} older, ${args.ages.undated} undated)`;
  }
  // The ring records what we INGESTED, not what we answered — a lead can die
  // downstream (triage, a verifier gate, an error) without a single word
  // reaching the person. "handled" was a claim the sweep cannot support, and it
  // was wrong in practice: "that one that says already handled is not handled".
  return `${args.ages.recent} replies within ${hours}h, all already ingested (nothing new to file)`;
}

async function harvestWithRetry<T>(
  tabId: number,
  send: Send,
  sleep: Sleep,
  attempts = 4,
): Promise<{ items: T[]; cards: number; contacted: boolean; lastError?: string }> {
  let contacted = false;
  let cards = 0;
  let lastError: string | undefined;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1200 * i); // 1.2s, 2.4s, 3.6s — the list is async
    try {
      const r = await send<{ ok: boolean; items: T[]; cards?: number }>(tabId, {
        cmd: "harvestNotifications",
      });
      contacted = true;
      const items = r?.items ?? [];
      // Keep the best card count we have seen: a later attempt that renders
      // fewer cards should not erase evidence that the page DID render.
      cards = Math.max(cards, r?.cards ?? items.length);
      // Replies present ⇒ done. Zero on an early attempt is far more likely to
      // be a half-rendered list than a genuinely empty inbox, so keep asking.
      if (items.length > 0) return { items, cards, contacted };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { items: [], cards, contacted, ...(lastError ? { lastError } : {}) };
}

export async function runNotificationSweep(
  tabId: number,
  deps: SweepDeps,
): Promise<SweepOutcome> {
  const { rng, sleep, send, api, cdp, wpm, navigate, stopped } = deps;

  await navigate(tabId, NOTIFICATIONS_URL);
  if (stopped()) return { fresh: 0, accepted: 0, skipped: 0, detail: "stopped" };
  await sleep(rng.float(1400, 2800)); // let the list hydrate

  // Read the page like a person: a scroll or two with dwells between.
  const passes = rng.int(1, 2);
  for (let i = 0; i < passes; i++) {
    if (stopped()) break;
    await sleep(readingDwellMs(rng, Math.round(rng.normal(44, 20)), {}, wpm));
    await cdp.wheel(tabId, { x: 500, y: 420 }, Math.round(rng.float(420, 1100)), rng, sleep);
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
  const fresh = selectRepliesToMe(harvested, { seen, max: MAX_PER_SWEEP });
  const ages = ageBuckets(harvested, MAX_AGE_MINUTES);
  // Every card the page rendered, not just the replies — see countNotificationCards.
  const cards = Math.max(probe.cards, harvested.length);

  // Keep the notifications page open when no fresh replies are eligible.
  if (fresh.length === 0) {
    const detail = describeEmptySweep({ harvested: cards, ages });
    return {
      fresh: 0,
      accepted: 0,
      skipped: 0,
      harvested: cards,
      ...(detail ? { detail } : {}),
    };
  }

  const nowIso = new Date().toISOString();
  const items = fresh.map((f) => toInboundItem(f, nowIso));
  const res = await api
    .postInboundReplies({ instanceId: deps.instanceId, platform: "linkedin", items })
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }) as const);
  if ("error" in res) {
    return { fresh: fresh.length, accepted: 0, skipped: 0, detail: `ingest-failed: ${res.error}` };
  }

  // Only remember what the server actually took a decision on. An item that
  // never reached api-vm stays unseen so the next sweep retries it.
  await chrome.storage.local.set({
    [SEEN_KEY]: mergeSeen(seen, items.map((i) => i.external_id), SEEN_CAP),
  });
  return { fresh: fresh.length, accepted: res.accepted, skipped: res.skipped };
}

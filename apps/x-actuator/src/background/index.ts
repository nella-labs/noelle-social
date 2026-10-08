import { NOTIFICATIONS_ACTOR_ENABLED } from "../lib/notifications-feature.js";
import { planTimeline, planDrainTimeline, inQuietDrainGap, pickDrainArchetype } from "../lib/scheduler.js";
import { makeRng } from "../lib/rng.js";
import { engagementLabel, type EngagementKind } from "../lib/engagement.js";
import { reactWithVariety, rectFrom, type Rect } from "./engage.js";
import { DEFAULT_DISCOVERY_SCHEDULE, DISCOVERY_SCHEDULE_KEY, parseDiscoverySchedule, type DiscoverySchedule } from "@noelle/actuator-cdp";
import { isXWriteQuiet } from "../lib/discovery-curfew.js";
import { ActuatorApi } from "../lib/api.js";
import type { ActuatorConfig } from "../lib/types.js";
import {
  loadState, saveIfCurrent, bumpEpoch, claimEpoch, runIfCurrent, currentEpoch,
  dueActionIndex, withinWindow, type RunState, type SlotAction,
} from "./state.js";
import { Cdp } from "./cdp.js";
import { notClearedDetail, submitNotFoundDetail, type SubmitObserved, type SubmitDiag } from "./detail.js";
import { mergePool, deferLater, shortfall, replyFailureDecision, shouldExtendDrain, drainShouldKeepWaiting, pipelineIsDry, preSendDecision, type PoolItem } from "./replenish.js";
import { runSubmitReply, type ReplyResult } from "./submit.js";
import { waitForReplyComposer } from "./composer.js";
import { chooseAmbient, runAmbient, shouldIdleLike, submitObservationBatch } from "./ambient.js";
import { createActorClickTabGuard, findPinnedXTab, isXPageUrl, restorePinnedXTab } from "./tab-guard.js";
import { chooseIdleActivity, notificationSweepDue, runNotificationSweep, SWEEP_MIN_GAP_MS, type SweepOutcome } from "./notifications.js";
import { makeSessionPersona, warmupSuppressWritesMs } from "../lib/session.js";
import { warmupCapMultiplier } from "../lib/warmup.js";
import { shouldAutoStart, shouldAutoDrain, shouldRecoverStalledRun, confirmStall, shouldSelfReload, shouldResumeDrain, localDayKey, passesAutoStartSafety, type StallProbe } from "../lib/autonomy.js";
import { readingDwellMs, decideStop, glanceMs } from "../lib/dwell.js";
import { abortableSleep, throwIfAborted, isAbortError } from "../lib/cancel.js";
import { tweetIdFrom, tweetDedupKey } from "../lib/urn.js";
import { isFeedUrl } from "../lib/feed.js";
import { bridgePulse, sinkLog } from "../lib/bridge-sink.js";
import { ActorReplyCapWriteSchema, type XActivityEvent } from "@noelle/contracts";
import { makeNavigateTab, runClearComposer } from "@noelle/actuator-cdp";
import { rollLikeSkip } from "../lib/like-skip.js";
import type { VisibleTweet } from "../content/discovery.js";
import { DISCOVERY_MODE_KEY, claimReplyBeforeSubmit, discoveryBrowseDecision, discoveryNavigationTarget, discoveryStartDecision, emptySearchFallbackUrl, integratePriorityReady, observationBatch, stampCompletedDiscoveryTarget } from "./discovery.js";

const ALARM = "actuator-tick";
const AUTONOMY_ALARM = "autonomy-check";
const POLL_MS = 7 * 60_000; // replenishment interval (jittered at use)
// Persistent drain (self-perpetuating "Drain all approvals"): while a drain has
// caught up (inbox empty), re-check the server queue this often so a reply
// approved later is picked up within ~30 seconds, with no operator re-click.
const DRAIN_WATCH_POLL_MS = 30_000;
// Roll a waiting drain's window this far forward each time it would otherwise
// expire, so the run keeps ticking while it watches for new approvals.
const DRAIN_WATCH_WINDOW_H = 1;
const PRIORITY_POLL_MS = 10_000;
const PENDING_OBSERVATIONS_KEY = "actuator.pendingXObservations";
const LAST_DISCOVERY_READ_KEY = "actuator.lastDryXDiscoveryMs";
const LAST_DISCOVERY_TARGET_KEY = "actuator.lastTargetXDiscoveryMs";
const PENDING_DISCOVERY_TARGET_KEY = "actuator.pendingXDiscoveryTarget";
const MAX_PENDING_OBSERVATIONS = 1000;
const cdp = new Cdp();
const childTabGuard = createActorClickTabGuard((id) => chrome.tabs.remove(id));

// Cooperative-cancellation handle for the LIVE run. STOP (endRun) aborts it, so
// every in-flight dwell — and every sleep inside the CDP motion engine, which
// receives this same `sleep` — collapses immediately instead of waiting out its
// timer. startRun/startDrain install a fresh one. Starts aborted: no run is live
// at load.
let runAbort = new AbortController();
runAbort.abort();
const sleep = (ms: number) => abortableSleep(ms, runAbort.signal);
/** True once the live run has been stopped/superseded (its work must unwind). */
const stopped = () => runAbort.signal.aborted;
// Run-independent sleep for the remote-intent loop's backoff: it must NOT collapse
// when a run's STOP aborts `runAbort` (the loop outlives every run).
const plainSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const browserDiscoveryEnabled = async () =>
  (await chrome.storage.local.get(DISCOVERY_MODE_KEY).catch(() => ({})) as Record<string, unknown>)[DISCOVERY_MODE_KEY] === true;
async function currentWriteQuiet(atMs: number, legacyCurfewEnabled: boolean): Promise<{
  held: boolean; discoveryActive: boolean; schedule: DiscoverySchedule;
}> {
  try {
    const stored = await chrome.storage.local.get([DISCOVERY_MODE_KEY, DISCOVERY_SCHEDULE_KEY]);
    const discoveryActive = stored[DISCOVERY_MODE_KEY] === true;
    const schedule = parseDiscoverySchedule(stored[DISCOVERY_SCHEDULE_KEY]);
    return { held: isXWriteQuiet(atMs, discoveryActive, legacyCurfewEnabled, schedule), discoveryActive, schedule };
  } catch {
    // A lost settings read must not turn an operator's quiet window into a write.
    return { held: true, discoveryActive: false, schedule: DEFAULT_DISCOVERY_SCHEDULE };
  }
}
const observedTweetIds = new Set<string>();

async function getConfig(): Promise<ActuatorConfig | null> {
  const r = await chrome.storage.local.get("actuator.config");
  return (r["actuator.config"] as ActuatorConfig) ?? null;
}
// Keep the run's pinned tab even if a stray link took it off X. Only look for
// another X tab when that exact tab has closed.
async function findXTab(pinnedId?: number | null): Promise<number | null> {
  return findPinnedXTab(
    pinnedId,
    (id) => chrome.tabs.get(id).catch(() => null),
    async () => {
      const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
      return tabs.map((t) => ({ id: t.id, url: t.url }));
    },
  );
}
function send<T>(tabId: number, msg: unknown): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<T>;
}
async function waitTabComplete(tabId: number, timeoutMs = 12_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (stopped()) return; // STOP fired — don't spin out the remaining ~12s
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") return;
    await sleep(400);
  }
}

async function actorClick(tabId: number, rect: Rect, rng: ReturnType<typeof makeRng>): Promise<void> {
  await childTabGuard.duringClick(tabId, () => cdp.moveAndClick(tabId, rect, rng, sleep));
}

const restoringPinnedTabs = new Set<number>();
async function recoverPinnedTab(tabId: number, isLive = async () => {
  const state = await loadState().catch(() => null);
  return state?.status === "running" && state.tabId === tabId && state.epoch === (await currentEpoch());
}): Promise<boolean> {
  if (restoringPinnedTabs.has(tabId)) return false;
  restoringPinnedTabs.add(tabId);
  try {
    const restored = await restorePinnedXTab(tabId, {
      isLive,
      getTab: () => chrome.tabs.get(tabId).catch(() => null),
      navigate: (id, url) => navigateTab(id, url, makeRng((Date.now() & 0xffffffff) >>> 0), isLive),
    });
    if (restored) await waitTabComplete(tabId);
    return restored;
  } catch {
    return false;
  } finally {
    restoringPinnedTabs.delete(tabId);
  }
}

// Re-assert the feed: if the actuated tab has wandered off x.com/home, pull it
// back before acting. A reply parks the tab on a /status/ permalink (in
// scheduled mode only drain used to return to /home), a mis-landed click can
// navigate onto a profile or a t.co link, and the operator can drive it away —
// and once off the feed the loop scrolls a page where findFeedTweets matches
// thread/profile tweets (or nothing), so likes drift off-surface or stall (the
// like scan chews on a thread page's few tweets forever). This single guard
// keeps EVERY feed-scoped action (scheduled likes and the ambient browse) on
// the home timeline. Conservative: navigates only when the url is known AND
// not the feed (an unknown/loading url is left alone). Best-effort — a failed
// nav just falls through to the caller's own scan.
async function ensureOnFeed(tabId: number, rng: ReturnType<typeof makeRng>): Promise<void> {
  const cur = await chrome.tabs.get(tabId).catch(() => null);
  if (!cur?.url || isFeedUrl(cur.url)) return;
  await navigateTab(tabId, "https://x.com/home", rng).catch(() => {});
  await waitTabComplete(tabId);
  await sleep(rng.float(900, 2600)); // let the first tweets hydrate
}

// `opts.curfew` selects the legacy Auto overnight write curfew; Discover + Reply
// uses its separate optional local-time window. Browsing continues. There
// is deliberately no `manual` flag here (the LinkedIn actuator has one): on X the
// extension never arms reply_send_enabled either way — see the block comment
// above endRun — so a run has nothing to switch on the operator's behalf.
type PendingStart = { epoch: Promise<number | null>; controller: AbortController };
function reserveStart(expectedEpoch?: number): PendingStart {
  return { epoch: claimEpoch(expectedEpoch), controller: new AbortController() };
}
async function activateStart(run: PendingStart): Promise<number | null> {
  const epoch = await run.epoch;
  if (epoch === null) return null;
  if (!(await runIfCurrent(epoch, async () => {
    runAbort.abort();
    runAbort = run.controller;
  }))) { run.controller.abort(); return null; }
  return epoch;
}
async function startIsCurrent(run: PendingStart, epoch: number): Promise<boolean> {
  const current = await currentEpoch();
  return !run.controller.signal.aborted && runAbort === run.controller && epoch === current;
}
async function finishStart(state: RunState, run: PendingStart): Promise<number | null> {
  if (!(await startIsCurrent(run, state.epoch)) || !(await saveIfCurrent(state))) return null;
  if (state.tabId != null && await startIsCurrent(run, state.epoch)) {
    await cdp.attach(state.tabId).catch(() => {});
    if (!(await startIsCurrent(run, state.epoch))) {
      // Only initiate cleanup for a stopped controller still owned here.
      if (runAbort === run.controller && run.controller.signal.aborted) await cdp.detach(state.tabId).catch(() => {});
      return null;
    }
  }
  if (!(await runIfCurrent(state.epoch, async () => {
    if (run.controller.signal.aborted) return;
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    if (run.controller.signal.aborted) return;
    for (const ms of [3500, 8000, 15000, 22000]) setTimeout(() => void tick(), ms);
  }))) return null;
  if (!(await startIsCurrent(run, state.epoch))) return null;
  return state.epoch;
}
function reserveStop(): Promise<number> {
  runAbort.abort();
  return bumpEpoch();
}

async function startRun(
  params: { windowHours: number; targetComments: number; targetLikes: number },
  opts?: { curfew?: boolean; expectedEpoch?: number },
  run = reserveStart(opts?.expectedEpoch),
): Promise<number | null> {
  const epoch = await activateStart(run);
  if (epoch === null) return null;
  const cfg = await getConfig();
  if (!cfg) throw new Error("not configured");
  if (!(await startIsCurrent(run, epoch))) return null;
  const api = new ActuatorApi(cfg);
  const queue = await api.fetchQueue();
  if (!(await startIsCurrent(run, epoch))) return null;
  const rng = makeRng((Date.now() & 0xffffffff) >>> 0);
  const startMs = Date.now();

  // Session persona + warm-up window: drawn once at run start and held for the
  // whole session (the "session-level entropy" that prevents a repeated
  // signature). persona.wpm threads into every reading-dwell call below.
  const persona = makeSessionPersona((Date.now() & 0xffffffff) >>> 0);
  // Warm-up suppresses writes for the first N ms (arrive/read before acting). Cap
  // it at 10% of the window so a short run isn't dominated by warm-up — a 30-min
  // window warms up ≤3 min, not the full ~4 min a long run would.
  const warmupSuppressMs = Math.min(
    warmupSuppressWritesMs(rng),
    Math.round(params.windowHours * 3600_000 * 0.1),
  );

  // Multi-day warm-up: a newly-automated identity ramps to full volume over ~4
  // weeks. Persist the automation start once (first run), then scale the daily
  // caps by the ramp multiplier so early sessions run lighter.
  const startStore = await chrome.storage.local.get("actuator.automationStartMs");
  let automationStartMs = startStore["actuator.automationStartMs"] as number | undefined;
  if (typeof automationStartMs !== "number") {
    automationStartMs = startMs;
    if (!(await runIfCurrent(epoch, () => chrome.storage.local.set({ "actuator.automationStartMs": automationStartMs })))) return null;
  }
  const warm = warmupCapMultiplier(automationStartMs, startMs);
  const effectiveCaps = {
    likes: Math.max(1, Math.round(cfg.caps.likes * warm)),
    comments: Math.round(cfg.caps.comments * warm),
    dms: Math.round(cfg.caps.dms * warm),
  };

  const { actions: planned } = planTimeline({
    params, approvedDms: queue.dms.length, caps: effectiveCaps, startMs,
    deepNightTaper: cfg.deepNightTaper, maxWritesPerHour: cfg.maxWritesPerHour ?? 8,
    // Plan AROUND the curfew when this run has one, so slots are not laid down
    // inside the band only to be deferred one by one at execution time.
    curfewEnabled: opts?.curfew === true,
    rng,
  });
  const actions: SlotAction[] = planned.map((a) => ({ kind: a.kind, atMs: a.atMs, executed: false }));

  // Pin the actuated tab NOW (preferring one already on /home) and remember it
  // on the run, so ticks keep driving this same tab while it stays open —
  // instead of re-picking tabs[0] every tick and following whichever x.com tab
  // sorts first.
  const tabId = await findXTab();
  const state: RunState = {
    sessionId: crypto.randomUUID(), epoch, startMs, windowHours: params.windowHours, actions,
    persona, warmupSuppressMs, tabId: tabId ?? undefined, curfewEnabled: opts?.curfew === true,
    targets: {
      likes: actions.filter((a) => a.kind === "like").length,
      comments: actions.filter((a) => a.kind === "comment").length,
      dms: actions.filter((a) => a.kind === "dm").length,
    },
    done: { likes: 0, comments: 0, dms: 0 },
    commentPool: queue.comments.map((c) => ({ approvalId: c.approval_id, draftId: c.draft_id, body: c.body, url: c.target.url })),
    dmPool: queue.dms.map((d) => ({ approvalId: d.approval_id, draftId: d.draft_id, body: d.body, url: d.target.url })),
    doneDraftIds: [], lastPollMs: startMs, status: "running",
  };
  return finishStart(state, run);
}

// Drain mode: post ALL approved replies a short gap apart (random 20–60s / 1–2 min),
// filling each gap with 4–8 likes + ambient browsing. Reuses the whole tick engine
// — it just builds a drain schedule and flags the run mode:"drain" (which makes each
// reply return to the x.com feed so the gap browses + likes). Newest tweet first
// (the /api/actionable-x queue is served newest-post-first). Epoch-based supersede,
// same as startRun — no warm-up suppression (drain is an explicit operator action).
async function startDrain(opts?: { manual?: boolean; curfew?: boolean; notifications?: boolean; expectedEpoch?: number },
  run = reserveStart(opts?.expectedEpoch),
): Promise<number | null> {
  const epoch = await activateStart(run);
  if (epoch === null) return null;
  const cfg = await getConfig();
  if (!cfg) throw new Error("not configured");
  if (!(await startIsCurrent(run, epoch))) return null;
  const api = new ActuatorApi(cfg);
  const queue = await api.fetchQueue();
  if (!(await startIsCurrent(run, epoch))) return null;
  const rng = makeRng((Date.now() & 0xffffffff) >>> 0);
  const startMs = Date.now();
  const persona = makeSessionPersona((Date.now() & 0xffffffff) >>> 0);
  // Per-session drain temperament, drawn from its OWN seed (NOT the wall-clock-
  // reseeded tick rng) so the plan stream is untouched. Persisted on RunState so
  // every auto-continue round shares the same mood (see maybeExtendDrain).
  const drainStyle = pickDrainArchetype(makeRng((Date.now() ^ 0x9e3779b1) >>> 0));

  const nComments = queue.comments.length;
  // drainStyle carries the archetype-shaped subset of DrainOpts, so spread it in.
  // shortBandProb is the ONE field combined with the operator's cfg knob by MIN
  // (placed AFTER the spread so it wins): the archetype can only ever LOWER the
  // short-band share, never raise the operator's lights-out setting — the drain
  // never runs faster than min(cfg, default).
  const planned = planDrainTimeline({
    approvedComments: nComments, startMs, rng,
    ...drainStyle,
    shortBandProb: Math.min(cfg.drainShortBandProb ?? 0.55, drainStyle.shortBandProb),
  });
  const actions: SlotAction[] = planned.map((a) => ({ kind: a.kind, atMs: a.atMs, executed: false }));
  const lastAt = actions.reduce((m, a) => Math.max(m, a.atMs), startMs);
  const windowHours = (lastAt - startMs) / 3600_000 + 0.15; // pad so the last slot fits

  const tabId = await findXTab(); // pin for the run (reused via s.tabId in tickOnce)
  const state: RunState = {
    sessionId: crypto.randomUUID(), epoch, startMs, windowHours, actions,
    persona, drainStyle, warmupSuppressMs: 0, mode: "drain", manualDrain: opts?.manual === true, curfewEnabled: opts?.curfew === true, notifications: opts?.notifications === true, tabId: tabId ?? undefined,
    targets: {
      likes: actions.filter((a) => a.kind === "like").length,
      comments: nComments,
      dms: 0,
    },
    done: { likes: 0, comments: 0, dms: 0 },
    commentPool: queue.comments.map((c) => ({ approvalId: c.approval_id, draftId: c.draft_id, body: c.body, url: c.target.url })),
    dmPool: [],
    doneDraftIds: [], lastPollMs: startMs, status: "running",
  };
  return finishStart(state, run);
}

// DELIBERATELY NO auto-enable/auto-disable of reply_send_enabled here — this is
// where the LinkedIn actuator differs and its pattern must NOT be ported. On
// LinkedIn the column has no consumer outside the actuator queue routes, so the
// extension can treat it as per-run consent. On X it is the MASTER GATE of the
// x-intern official-API send worker (apps/x-intern/src/workers/send.ts): once
// true, that worker's tick fires ANY auto_send_target_at-stamped pending
// approval via the official API — an unattended SECOND sender armed over the
// same approval pool as this extension (duplicate public posts). And disabling
// it at run end would silently revoke the operator's STANDING dashboard consent
// (killing Vega's API autosend after any manual actuator run). So the browser
// actuator never writes the flag: consent for the X actuator is the operator
// flipping reply sending on the Vega agent page (docs/x-actuator-plan.md), and
// the org-wide panic-stop stays the single authority over the column.

async function endRun(status: RunState["status"], terminal = reserveStop()): Promise<number> {
  const term = await terminal;
  // Abort immediately when STOP is reserved, then recheck the owned controller
  // after the epoch write: a start may have activated while that write waited.
  if (!(await runIfCurrent(term, async () => {
    runAbort.abort();
    if (status === "halted-challenge") {
      await chrome.storage.local.set({ [CHALLENGE_DAY_KEY]: localDayKey(new Date()) });
    }
  }))) return term;
  const s = await loadState();
  if (s) {
    s.status = status;
    s.epoch = term;
    if (!(await saveIfCurrent(s))) return term;
    // Detach every tab this run attached (it may have re-pinned after its tab
    // closed) — a single re-looked-up detach could miss one and leave the
    // "Extension is debugging this browser" banner up after the run halts.
    if (term === await currentEpoch()) await cdp.detachAll();
    // shortfall logging (no silent truncation)
    const cfg = await getConfig();
    if (cfg) {
      const api = new ActuatorApi(cfg);
      // NOTE: no enableSend(false) here — the X actuator never touches
      // reply_send_enabled (see the block comment above endRun). Disabling it
      // would revoke the operator's standing dashboard consent and kill the
      // x-intern API autosend pipeline after any manual actuator run.
      const events: XActivityEvent[] = [];
      const at = new Date(Date.now()).toISOString();
      const miss = shortfall(s.targets.comments, s.done.comments);
      if (miss > 0) events.push({ type: "skip", reason: `shortfall-replies-${miss}`, at });
      if (events.length) await api.logActivity(s.sessionId, events).catch(() => {});
    }
  }
  await runIfCurrent(term, async () => { await chrome.alarms.clear(ALARM); });
  return term;
}

// Drain auto-continue. A drain plans a FIXED number of reply slots (the queue
// size at start), so it used to STOP after that first batch even when the inbox
// still held approvals — the ones that arrived mid-run, or that were re-queued
// after a transient failure ("the actuator stopped before finishing the
// approvals inbox"). When every planned slot is done, re-fetch the queue and, if
// pending replies remain, APPEND a fresh batch of comment+like slots and extend
// the window — so one operator Drain clears the WHOLE inbox without a manual
// re-trigger. Returns true iff it extended (caller keeps the run running).
// Bounded by MAX_DRAIN_ROUNDS. Naturally self-limiting: an empty queue (nothing
// left, or sending disabled server-side) returns false → the drain ends;
// replies that keep failing hit the per-draft retry cap → doneDraftIds →
// filtered out of the next fetch → remaining reaches 0.
async function maybeExtendDrain(
  s: RunState, cfg: ActuatorConfig, api: ActuatorApi, now: number, rng: ReturnType<typeof makeRng>,
): Promise<boolean> {
  if (s.mode !== "drain") return false;
  const q = await api.fetchQueue().catch(() => null);
  if (!q) return false;
  const done = new Set(s.doneDraftIds);
  s.commentPool = mergePool(
    s.commentPool,
    q.comments.map((c) => ({ approvalId: c.approval_id, draftId: c.draft_id, body: c.body, url: c.target.url })),
    done,
  );
  s.lastPollMs = now; // this fetch counts as a poll; don't double-fetch next tick
  const remaining = s.commentPool.length;
  if (!shouldExtendDrain(s.mode, s.drainRounds ?? 0, remaining)) return false;

  // Plan a fresh drain batch for the remaining replies, starting shortly from
  // now, and splice it onto the timeline. The existing comment-slot executor
  // shifts these off s.commentPool exactly as it did the first batch.
  // Carry the SAME persisted session temperament so every round keeps one coherent
  // mood (old states without drainStyle fall back to today's defaults via `?? {}`).
  // shortBandProb stays MIN-combined with the operator cfg knob (placed after the
  // spread → wins) so a round never drains faster than min(cfg, default).
  const style = s.drainStyle;
  const planned = planDrainTimeline({
    approvedComments: remaining, startMs: now, rng,
    ...(style ?? {}),
    shortBandProb: style ? Math.min(cfg.drainShortBandProb ?? 0.55, style.shortBandProb) : cfg.drainShortBandProb,
  });
  const newLast = planned.reduce((m, a) => Math.max(m, a.atMs), now);
  for (const a of planned) s.actions.push({ kind: a.kind, atMs: a.atMs, executed: false });
  s.windowHours = (newLast - s.startMs) / 3600_000 + 0.15; // extend so the new tail fits
  s.targets.comments += remaining;
  s.targets.likes += planned.filter((a) => a.kind === "like").length;
  s.drainRounds = (s.drainRounds ?? 0) + 1;
  s.lastEvent = `draining more — ${remaining} left in inbox (round ${s.drainRounds})`;
  return true;
}

async function maybeReplenish(s: RunState, api: ActuatorApi, now: number, rng: ReturnType<typeof makeRng>) {
  if (now - s.lastPollMs < POLL_MS * rng.float(0.8, 1.6)) return;
  s.lastPollMs = now;
  const q = await api.fetchQueue().catch(() => null);
  if (!q) return;
  const done = new Set(s.doneDraftIds);
  s.commentPool = mergePool(s.commentPool, q.comments.map((c) => ({ approvalId: c.approval_id, draftId: c.draft_id, body: c.body, url: c.target.url })), done);
  s.dmPool = mergePool(s.dmPool, q.dms.map((d) => ({ approvalId: d.approval_id, draftId: d.draft_id, body: d.body, url: d.target.url })), done);
}

// Ambient read-actions (expand "Show more" / open a tweet's replies to read) are
// paced by a rolling cooldown so they cluster like real reading instead of
// firing on every ~4s idle tick. Base gap × a 1–2 jitter ⇒ roughly one every
// 20–40s at most; many attempts also find nothing in view and downgrade to a
// scroll, so the real rate is lower. Read-only + non-counted against targets.
// Tightened (was 30s×1–2.5) so the actor actively clicks "Show more" while waiting.
const AMBIENT_READ_MIN_GAP_MS = 20_000;

// Minimum spacing between idle-likes (a like slipped into the wait between
// scheduled actions), so waiting-gap likes are paced like a human rather than
// fired every ~4s tick. The like scan itself is several seconds, so this also
// keeps a like-less feed from being hammered.
// Quiet re-tune (port of Lyra #497): raised 45s -> 5 min. Idle-likes are
// budget-bounded either way, so this does not change VOLUME; it spreads the same
// likes over more wall clock, the direction docs/x-account-safety.md asks for.
// On X this constant did strictly more work than on LinkedIn because it governed
// Run/auto AND every non-cooldown drain gap; the drain half is now gated off
// entirely at the call site below.
const IDLE_LIKE_MIN_GAP_MS = 300_000;

// One ambient browse: pick a behavior (read-actions gated by cooldown + config
// kill switch, default ON) and run it. Advances the cooldown anchor only on an
// action that actually happened, so a downgraded-to-scroll attempt doesn't burn
// the gap. Mutates `s` in place; the caller persists it.
async function pendingObservations(): Promise<Map<string, VisibleTweet>> {
  const stored = await chrome.storage.local.get(PENDING_OBSERVATIONS_KEY).catch(() => ({})) as Record<string, unknown>;
  const previous = Array.isArray(stored[PENDING_OBSERVATIONS_KEY])
    ? stored[PENDING_OBSERVATIONS_KEY] as VisibleTweet[] : [];
  return new Map(previous.filter((v) => v && typeof v.tweetId === "string").map((v) => [v.tweetId, v]));
}

async function wakeDiscoveryRead(): Promise<void> {
  await chrome.storage.session.set({ [LAST_DISCOVERY_READ_KEY]: 0 });
}

async function submitPendingObservations(api: ActuatorApi, pending: Map<string, VisibleTweet>, budget: { remaining: number }): Promise<number | null> {
  const batch = observationBatch([...pending.values()], budget.remaining);
  if (batch.length === 0 || stopped() || !(await browserDiscoveryEnabled())) return null;
  // Persist before the HTTP request. A failed or ambiguous submission keeps
  // its reservation and the durable batch for the next paced read.
  await chrome.storage.local.set({ [PENDING_OBSERVATIONS_KEY]: [...pending.values()] });
  if (stopped()) return null;
  try {
    const accepted = await submitObservationBatch(batch, budget, (items) => api.postObservations(items));
    for (const item of batch) { pending.delete(item.tweetId); observedTweetIds.add(item.tweetId); }
    if (observedTweetIds.size > 2000) observedTweetIds.clear();
    await chrome.storage.local.set({ [PENDING_OBSERVATIONS_KEY]: [...pending.values()] });
    return accepted;
  } catch (error) {
    console.warn("[x-discovery] observations retained for retry", error);
    return null;
  }
}

async function observeVisibleTweets(tabId: number, api: ActuatorApi, budget: { remaining: number }): Promise<{ visible: number; accepted: number } | void> {
  if (budget.remaining <= 0 || stopped() || !(await browserDiscoveryEnabled())) return;
  const harvest = await send<{ ok: boolean; items?: VisibleTweet[] }>(tabId, { cmd: "harvestVisibleTweets" }).catch(() => null);
  if (!harvest?.ok) return;
  const visibleCount = harvest?.items?.length ?? 0;
  const pending = await pendingObservations();
  for (const item of harvest?.items ?? []) {
    if (!observedTweetIds.has(item.tweetId) && (pending.has(item.tweetId) || pending.size < MAX_PENDING_OBSERVATIONS)) {
      pending.set(item.tweetId, item);
    }
  }
  const accepted = pending.size > 0 ? await submitPendingObservations(api, pending, budget) : 0;
  if (accepted === null) return;
  return { visible: visibleCount, accepted };
}

async function ambientBrowse(
  s: RunState,
  cfg: ActuatorConfig,
  tabId: number,
  rng: ReturnType<typeof makeRng>,
  now: number,
): Promise<"browsed" | "waiting" | "full" | "unavailable" | "buffered"> {
  const api = new ActuatorApi(cfg);
  const discovery = await browserDiscoveryEnabled();
  let budget = { remaining: 0 };
  let lastTargetMs: number | null = null;
  let pendingTarget: unknown = null;
  if (discovery) {
    const lastReadStore = await chrome.storage.session.get([
      LAST_DISCOVERY_READ_KEY, LAST_DISCOVERY_TARGET_KEY, PENDING_DISCOVERY_TARGET_KEY,
    ]).catch(() => null) as Record<string, unknown> | null;
    if (!lastReadStore) {
      console.warn("[x-discovery] target cache read failed");
      return "unavailable";
    }
    const lastRead = Number(lastReadStore[LAST_DISCOVERY_READ_KEY] ?? 0);
    const storedTargetMs = lastReadStore[LAST_DISCOVERY_TARGET_KEY];
    if (typeof storedTargetMs === "number" && Number.isFinite(storedTargetMs)) lastTargetMs = storedTargetMs;
    pendingTarget = lastReadStore[PENDING_DISCOVERY_TARGET_KEY] ?? null;
    // A full buffer or outage also consumes this read opportunity: no repeated
    // capacity request or continuous scroll on the actor's ~4s idle ticks.
    if (discoveryBrowseDecision({ enabled: true, lastReadMs: lastRead, nowMs: now, available: 1 }) === "waiting") return "waiting";
    await chrome.storage.session.set({ [LAST_DISCOVERY_READ_KEY]: now });
    const capacity = await api.fetchDiscoveryCapacity().catch(() => null);
    if (stopped() || s.epoch !== (await currentEpoch())) return "waiting";
    const decision = discoveryBrowseDecision({ enabled: true, lastReadMs: lastRead, nowMs: now, available: capacity?.available ?? null });
    if (decision !== "browse") return decision;
    budget = { remaining: capacity!.available };
    const pending = await pendingObservations();
    if (pending.size > 0) {
      await submitPendingObservations(api, pending, budget);
      return "buffered";
    }
  }
  // Ambient browsing is feed behavior: a reply parks the tab on a /status/
  // permalink (and a mis-landed click can navigate anywhere), so re-assert
  // /home first or the "browsing" dwells idle on whatever page the last write
  // left behind.
  await ensureOnFeed(tabId, rng);
  if (stopped() || s.epoch !== (await currentEpoch())) return "waiting";
  const readEnabled = cfg.ambientReadActions !== false; // undefined ⇒ ON
  const sinceRead = now - (s.lastAmbientReadMs ?? 0);
  const readActionsAllowed = readEnabled && sinceRead > AMBIENT_READ_MIN_GAP_MS * rng.float(1, 2.6);
  // Purposeful watched-profile/keyword reads use the same pinned X tab. Give
  // them their own share of eligible discovery reads; idle choices stay on feed.
  const navigationTarget = discovery ? await discoveryNavigationTarget({
    nowMs: now,
    lastSelectedMs: lastTargetMs,
    randomRoll: rng.next(),
    cachedTarget: pendingTarget,
    fetchTarget: () => api.fetchDiscoveryTarget().catch(() => {
      console.warn("[x-discovery] target fetch failed");
      return null;
    }),
    cacheTarget: (target) => chrome.storage.session.set({ [PENDING_DISCOVERY_TARGET_KEY]: target }),
    discardCachedTarget: () => chrome.storage.session.set({ [PENDING_DISCOVERY_TARGET_KEY]: null }),
    onCacheFailure: () => console.warn("[x-discovery] target cache write failed"),
  }) : null;
  const kind = navigationTarget ? "navigate" : chooseAmbient(rng, { readActionsAllowed });
  if (stopped() || s.epoch !== (await currentEpoch())) return "waiting";
  const did = await runAmbient(tabId, kind, {
    cdp, click: (id, rect) => actorClick(id, rect, rng), rng, sleep, send, wpm: s.persona.wpm,
    navigate: (id, url) => navigateTab(id, url, rng, async () => !stopped() && s.epoch === (await currentEpoch())),
    ...(navigationTarget ? {
      navigationTarget,
      emptySearchFallbackTarget: emptySearchFallbackUrl(navigationTarget) ?? undefined,
      canReadMore: async () => budget.remaining > 0 && !stopped() && s.epoch === (await currentEpoch()),
      onPageRead: (id: number) => observeVisibleTweets(id, api, budget).catch((e) => {
        console.warn("[x-discovery] target read failed", e);
      }),
    } : {}),
  }).catch(() => null);
  if (discovery) {
    await stampCompletedDiscoveryTarget({
      outcome: did,
      targetUrl: navigationTarget,
      completedAtMs: Date.now(),
      commitVisit: ({ completedAtMs, pendingTarget }) => chrome.storage.session.set({
        [LAST_DISCOVERY_TARGET_KEY]: completedAtMs,
        [PENDING_DISCOVERY_TARGET_KEY]: pendingTarget,
      }),
      onStampFailure: () => console.warn("[x-discovery] target read stamp failed"),
    });
    if (!stopped()) await observeVisibleTweets(tabId, api, budget).catch((e) => {
      console.warn("[x-discovery] feed read failed", e);
    });
  }
  if (did === "expand") s.lastAmbientReadMs = now;
  return "browsed";
}

// Live-browser deps for reactWithVariety (src/background/engage.ts — the
// orchestration is a plain function over these primitives so its stale-rect
// discipline is unit-tested; only this wiring touches chrome.* / CDP). The
// contract enforced in engage.ts: after any locate that scrolled the page, only
// freshly-located rects are clicked, and a fallback re-locate miss delivers
// NOTHING (the caller records a skip) instead of a blind trusted CDP click at
// stale viewport coordinates.
function engageDeps(tabId: number, rng: ReturnType<typeof makeRng>) {
  return {
    click: (rect: Rect) => actorClick(tabId, rect, rng),
    locateEngagement: (engagement: EngagementKind, tweet_id: string | null) =>
      send<{ ok: boolean; x?: number; y?: number; rect?: Rect }>(
        tabId, { cmd: "locateEngagement", engagement, tweet_id },
      ),
    locateRepostConfirm: () =>
      send<{ ok: boolean; x?: number; y?: number; rect?: Rect }>(
        tabId, { cmd: "locateRepostConfirm" },
      ),
    dismissMenu: () => cdp.pressEscape(tabId),
    sleep,
  };
}

// Like one hydrated feed tweet as a human would: make sure we're on the timeline,
// scroll-and-poll until a likeable tweet attaches, read it (dwelling proportional
// to its length, sometimes expanding "Show more" first), then land a trusted
// click. Returns true iff a like was actually landed; increments s.done.likes and
// pushes the activity event on success, or a skip event on a miss. Shared by the
// scheduled 'like' slot and idle-liking so both behave identically.
async function likeAFeedPost(
  tabId: number,
  s: RunState,
  cfg: ActuatorConfig,
  rng: ReturnType<typeof makeRng>,
  events: XActivityEvent[],
  at: string,
): Promise<boolean> {
  // A standalone feed-like must run ON the timeline. After a reply the tab is
  // left on a tweet permalink, where findFeedTweets finds no timeline cards →
  // every like skipped `no-likeable-tweet(tweets=0)`. Pull it back first via
  // the SHARED guard (ensureOnFeed, also used by the ambient browse — one
  // isFeedUrl notion of feed-ness instead of a local regex). Best-effort — a
  // failed nav just falls through to the scan.
  await ensureOnFeed(tabId, rng);
  // Scroll-and-poll: the like button only attaches once a tweet is hydrated near
  // the viewport, so one blind scroll + immediate locate often finds nothing
  // likeable. Retry with small scrolls + waits to let tweets hydrate.
  type LikeLoc = {
    ok: boolean; x?: number; y?: number; rect?: Rect;
    observed?: {
      tweet_id?: string; author_handle?: string;
      wordCount?: number; hasMedia?: boolean; isTruncated?: boolean;
      seeMoreRect?: Rect;
    };
    skipReason?: string;
  };
  let loc: LikeLoc | null = null;
  const preferWatchlist = cfg.preferWatchlistRatio > rng.next();
  for (let attempt = 0; attempt < 5; attempt++) {
    if (stopped()) break; // STOP mid-scan — abandon the hunt
    await cdp.wheel(tabId, { x: 400, y: 400 }, attempt === 0 ? Math.round(rng.float(480, 820)) : Math.round(rng.float(300, 540)), rng, sleep);
    await sleep(rng.float(450, 1350)); // let the social-action bar hydrate
    loc = await send<LikeLoc>(tabId, { cmd: "locateLike", preferWatchlist, watchlistNames: [] }).catch(() => null);
    if (loc?.ok && loc.x != null && loc.y != null) break;
  }
  if (loc?.ok && loc.x != null && loc.y != null) {
    // Read the tweet like a human BEFORE reacting: dwell proportional to its
    // length, and sometimes expand "Show more" then read the fuller text.
    let wc = loc.observed?.wordCount ?? 0;
    const media = loc.observed?.hasMedia ?? false;
    const trunc = loc.observed?.isTruncated ?? false;
    const seeMoreRect = loc.observed?.seeMoreRect;
    const tweetId = loc.observed?.tweet_id ?? null;
    const deps = engageDeps(tabId, rng);
    let likeRect = rectFrom(loc);
    const stop = decideStop(rng, wc, { hasMedia: media });
    if (stop && trunc && seeMoreRect && rng.next() < 0.7) {
      // expand-then-read: itself a strong human decoy action
      await actorClick(tabId, seeMoreRect, rng);
      await sleep(rng.float(300, 1100));
      wc = Math.round(wc * 2.2); // fuller text now visible → longer read
      // The expansion REFLOWS the tweet (its action bar moves down), so the like
      // rect measured before the expand is stale. Re-locate the heart on the
      // SAME tweet for a fresh rect; if it can't be re-found (tweet id unknown,
      // card gone), skip rather than fire a trusted click at stale coordinates.
      const fresh = await deps.locateEngagement("like", tweetId).catch(() => null);
      if (fresh?.ok && fresh.x != null) {
        likeRect = rectFrom(fresh);
      } else {
        events.push({ type: "skip", reason: "like-gone-after-expand", at });
        return false;
      }
    }
    await sleep(stop ? readingDwellMs(rng, wc, { hasMedia: media }, s.persona.wpm) : glanceMs(rng));
    throwIfAborted(runAbort.signal); // STOP during the read → don't land the like
    // Re-locate the like button immediately before reacting. The rect captured
    // before the read goes STALE even without an expand: live timeline
    // insertion and lazy media shift the card, so the pre-read coordinates can
    // land in the tweet BODY (an @mention → a profile, a t.co link → off-site),
    // which navigates the tab off the feed AND misses the like. Locate the
    // heart on the SAME tweet. A miss or lost response cannot confirm the
    // pre-read rect is still current, so skip unless fresh coordinates arrive.
    const preClick = await deps.locateEngagement("like", tweetId).catch(() => null);
    if (preClick?.ok !== true || preClick.x == null || preClick.y == null) {
      events.push({ type: "skip", reason: "like-location-unavailable", at });
      return false;
    }
    likeRect = rectFrom(preClick);
    throwIfAborted(runAbort.signal); // STOP during the re-locate → don't land the like
    const engagement = await reactWithVariety(likeRect, tweetId, cfg.engagementWeights, rng, deps);
    if (engagement == null) {
      // Variety attempt missed AND the fresh-rect fallback missed too (see
      // engage.ts): nothing landed, so count nothing — a phantom s.done.likes++
      // would burn a budgeted like on a click that never happened.
      events.push({ type: "skip", reason: "engagement-not-landed", at });
      return false;
    }
    s.done.likes++;
    events.push({ type: "like", tweet_id: loc.observed?.tweet_id, author_handle: loc.observed?.author_handle, engagement, at });
    return true;
  }
  events.push({ type: "skip", reason: loc?.skipReason ?? "like-failed", at });
  return false;
}

// Serialize ticks so the content-script-driven loop can't overlap with the
// alarm-driven one (overlap would double-read/write state).
let ticking = false;
let discoveryDrainAfterTick: number | null = null;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await tickOnce();
  } finally {
    ticking = false;
    if (discoveryDrainAfterTick !== null) {
      const expectedEpoch = discoveryDrainAfterTick;
      discoveryDrainAfterTick = null;
      if (await browserDiscoveryEnabled() && !stopped()) {
        await startDrain({ manual: true, curfew: false, expectedEpoch }).catch((error) =>
          console.warn("[x-discovery] deferred drain start failed", error));
      }
    }
  }
}

async function tickOnce() {
  const s = await loadState();
  const cfg = await getConfig();
  if (!s || !cfg || s.status !== "running") return;
  // Stale-run guard: if a newer run started or STOP fired since this state was
  // written, our epoch is no longer current — bail without acting or saving so a
  // superseded/stopped run can't spring back to life.
  const myEpoch = s.epoch ?? 0;
  if (myEpoch !== (await currentEpoch())) return;
  const now = Date.now();
  if (!withinWindow(s.startMs, s.windowHours, now)) {
    // A persistent drain never times out on its window — roll it forward and keep
    // ticking so it can watch for new approvals. Every other run ends here.
    if (drainShouldKeepWaiting(s.mode, s.drainRounds ?? 0)) {
      s.windowHours = (now - s.startMs) / 3600_000 + DRAIN_WATCH_WINDOW_H;
    } else {
      await endRun("idle");
      return;
    }
  }

  // Reuse the run's pinned tab while it is still open, including after an
  // accidental off-X navigation. Only re-pick if that exact tab closed.
  const tabId = await findXTab(s.tabId);
  if (tabId == null) return; // no tab → pause; resume next tick
  if (s.tabId !== tabId) s.tabId = tabId; // pin (or re-pin after the old tab closed)
  await recoverPinnedTab(tabId, async () => !stopped() && myEpoch === (await currentEpoch()));
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!currentTab?.url || !isXPageUrl(currentTab.url) ||
      (currentTab.pendingUrl && !isXPageUrl(currentTab.pendingUrl))) return;
  await cdp.attach(tabId).catch(() => {}); // idempotent; re-attach if a detach happened

  const api = new ActuatorApi(cfg);
  const rng = makeRng((now & 0xffffffff) >>> 0);
  await maybeReplenish(s, api, now, rng);

  // challenge guard
  const ch = await send<{ observed?: { challenge?: boolean } }>(tabId, { cmd: "detectChallenge" }).catch(() => null);

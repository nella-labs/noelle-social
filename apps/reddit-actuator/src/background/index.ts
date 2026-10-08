import { planTimeline, planDrainTimeline, inQuietDrainGap, pickDrainArchetype } from "../lib/scheduler.js";
import { makeRng } from "../lib/rng.js";
import { ActuatorApi, readCapturedReply, type EngineQueueItem } from "../lib/api.js";
import { type ActuatorConfig, REDDIT_DEFAULTS } from "../lib/types.js";
import {
  loadState, saveState, saveIfCurrent, bumpEpoch, currentEpoch,
  dueActionIndex, withinWindow, sanitizeReplyBody, replySpacingOk,
  canUpvoteNow, upvotesInWindow, shouldDisableSendOnRunEnd, armedByManualEnable,
  setPendingArm, getPendingArm, clearPendingArm, classifyPendingArm, inheritsArmOnSupersede,
  type RunState, type SlotAction, type RedditPoolItem,
} from "./state.js";
import { makeSerialQueue } from "../lib/serialize.js";
import { Cdp } from "./cdp.js";
import { engageWithVariety, type EngageDeps, type EngageLocate } from "./engage.js";
import { mergePool, deferLater, shortfall, retryDecision, shouldExtendDrain, drainShouldKeepWaiting, pipelineIsDry } from "./replenish.js";
import { recordReplySuccess, recordReplyHold, recordRemovedSkip, markSentWithRetry, classifyRemovedProbe } from "./marksent.js";
import type { RemovedProbe } from "./marksent.js";
import { chooseAmbient, runAmbient } from "./ambient.js";
import { isWriteCurfew } from "../lib/curfew.js";
import { makeSessionPersona, warmupSuppressWritesMs } from "../lib/session.js";
import { warmupCapMultiplier } from "../lib/warmup.js";
import { shouldAutoStart, shouldAutoDrain, shouldRecoverStalledRun, confirmStall, shouldSelfReload, localDayKey, passesAutoStartSafety, type StallProbe } from "../lib/autonomy.js";
import { postIdFromUrl } from "../lib/thing.js";
import { readingDwellMs, decideStop, glanceMs } from "../lib/dwell.js";
import { isFeedUrl, chooseActuatorTab } from "../lib/feed.js";
import { postDedupKey, postIdFrom } from "../lib/urn.js";
import { locatedCommentMatches } from "../content/locators.js";
import type { LocateResult } from "../content/locators.js";
import { notClearedDetail, submitNotFoundDetail, type SubmitObserved, type SubmitDiag } from "./detail.js";
import { submitRedditReply } from "./reply-submit.js";
import { bridgePulse, sinkLog } from "../lib/bridge-sink.js";
import { abortableSleep, throwIfAborted, isAbortError } from "../lib/cancel.js";
import type { ChallengeResult } from "../content/selectors.js";
import type { RedditActivityEvent } from "@noelle/contracts";
import { makeNavigateTab, runClearComposer } from "@noelle/actuator-cdp";

// The Reddit feed we return to after a drain reply so the inter-reply gap's
// ambient browsing (scroll + read decoys) lands on content, not the just-posted
// thread. www is fine here — ambient.ts navigates www.reddit.com regardless.
const REDDIT_FEED_URL = "https://www.reddit.com/";

const ALARM = "actuator-tick";
const AUTONOMY_ALARM = "autonomy-check";
const POLL_MS = 7 * 60_000; // replenishment interval (jittered at use)
// Persistent drain (self-perpetuating "Drain all approvals"): while a drain has
// caught up (inbox empty), re-check the server queue this often so a reply
// approved later goes out within ~a minute, with no operator re-click.
const DRAIN_WATCH_POLL_MS = 75_000;
// Roll a waiting drain's window this far forward each time it would otherwise
// expire, so the run keeps ticking while it watches for new approvals.
const DRAIN_WATCH_WINDOW_H = 1;
const cdp = new Cdp();

// Cooperative-cancellation handle for the LIVE run. STOP (endRun) aborts it, so
// every in-flight dwell — and every sleep inside the CDP motion engine, which
// receives this same `sleep` — collapses immediately instead of waiting out its
// timer. startRun/startDrain install a fresh one. Starts aborted: no run is live
// at load. Post-STOP WRITE safety is already covered by the epoch machinery; this
// closes the responsiveness hole (a reading dwell / ambient read ignored STOP
// until it finished).
let runAbort = new AbortController();
runAbort.abort();
const sleep = (ms: number) => abortableSleep(ms, runAbort.signal);
/** True once the live run has been stopped/superseded (its work must unwind). */
const stopped = () => runAbort.signal.aborted;
// Run-independent sleep for the remote-intent loop's backoff: it must NOT collapse
// when a run's STOP aborts `runAbort` (the loop outlives every run).
const plainSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Serialize every reply-switch write (enable on manual run-start, disable on
// run-end) so a run-end's disable and a fresh run's enable can NEVER interleave.
// Combined with the epoch + armedSend check inside endRun's disable, this makes
// the outcome deterministic under any timing: whichever op runs second sees the
// other's epoch bump — a superseded run-end skips its disable, and a fresh run's
// enable, if it runs after a disable, is the last write. Closes the "sending
// disabled at fetch time → empty queue → 0/0 despite pending drafts" race.
const withSendSwitch = makeSerialQueue();

type Rect = { x: number; y: number; width: number; height: number };
// A located element carries its rect now (for the Gaussian click point + Fitts
// W). Older message shapes / fallbacks may only have x,y — wrap them in a tiny
// rect so moveAndClick always has a box to sample.
function rectFrom(loc: { rect?: Rect; x?: number; y?: number }): Rect {
  if (loc.rect && loc.rect.width > 0 && loc.rect.height > 0) return loc.rect;
  const x = loc.x ?? 0;
  const y = loc.y ?? 0;
  return { x: x - 2, y: y - 2, width: 4, height: 4 };
}

async function getConfig(): Promise<ActuatorConfig | null> {
  const r = await chrome.storage.local.get("actuator.config");
  return (r["actuator.config"] as ActuatorConfig) ?? null;
}
// Choose the tab to actuate from every open reddit.com tab. Prefers the run's
// pinned tab (while it is still open), else a tab actually on a feed, else the
// first reddit tab — see chooseActuatorTab. The old `tabs[0]` picked the leftmost
// reddit tab with no notion of feed-ness, so a permalink/profile tab that merely
// sorted first (the operator's own) could silently hijack the loop.
async function findRedditTab(pinnedId?: number | null): Promise<number | null> {
  const tabs = await chrome.tabs.query({ url: ["https://www.reddit.com/*", "https://old.reddit.com/*"] });
  return chooseActuatorTab(tabs.map((t) => ({ id: t.id, url: t.url })), pinnedId);
}

// Optionally rewrite the target to old.reddit.com (opt-in via preferOldReddit).
// DEFAULT is new Reddit — posting through the same interface the operator browses
// keeps the account's write interface consistent with its reads (blend-in). old
// Reddit is a distinct, more conspicuous write surface, so it is never forced.
// Rewrites only the www/bare reddit.com host; anything else (already
// old.reddit.com, or a non-reddit url) is returned untouched.
function targetUrl(rawUrl: string, preferOld: boolean): string {
  if (!preferOld) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (u.hostname === "www.reddit.com" || u.hostname === "reddit.com") {
      u.hostname = "old.reddit.com";
      return u.toString();
    }
  } catch {
    /* not a parseable URL — navigate as-is */
  }
  return rawUrl;
}
function send<T>(tabId: number, msg: unknown): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<T>;
}
async function waitTabComplete(tabId: number, timeoutMs = 12_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (stopped()) return; // STOP fired — don't spin out the remaining timeout
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") return;
    await sleep(400);
  }
}

// Re-assert the feed: if the actuated tab has wandered off a feed, pull it back
// before acting. A scheduled reply parks the tab on the thread's permalink, a
// mis-landed click can open a permalink or /user profile, and the operator can
// drive it away — and once off the feed the idle upvote/ambient path acts on
// whatever page the tab is on (findFeedUpvoteTarget matches shreddit-post cards
// on /user profiles and permalink pages too). This single guard keeps every
// feed-scoped action (idle-upvotes and the ambient browse) on a real feed.
// Conservative: navigates only when the url is known AND not a feed (an
// unknown/loading url is left alone). Best-effort — a failed nav just falls
// through to the caller's own scan.
async function ensureOnFeed(tabId: number, rng: ReturnType<typeof makeRng>): Promise<void> {
  const cur = await chrome.tabs.get(tabId).catch(() => null);
  if (!cur?.url || isFeedUrl(cur.url)) return;
  await navigateTab(tabId, REDDIT_FEED_URL, rng).catch(() => {});
  await waitTabComplete(tabId);
  await sleep(rng.float(900, 2600)); // let the first cards hydrate
}

async function startRun(
  params: { windowHours: number; targetComments: number; targetLikes: number },
  opts?: { manual?: boolean },
) {
  const cfg = await getConfig();
  if (!cfg) throw new Error("not configured");
  // Fresh cancellation handle for this run. Abort any prior one first so a
  // superseded run's in-flight dwells collapse now instead of lingering.
  runAbort.abort();
  runAbort = new AbortController();
  // Bump the run generation FIRST. If a run is already live (a double-press, or
  // an auto-start racing a manual Run), this supersedes it: any in-flight tick
  // from the old run loaded a now-stale epoch and will bail instead of writing
  // its plan back. This is what stops the "0/36 ↔ 0/30" counter flip-flop.
  const epoch = await bumpEpoch();
  // Enable sending HERE — after this run owns the newest epoch, before fetchQueue
  // reads the approval queue. A just-ended prior run's endRun disable is
  // epoch-guarded, so it can no longer flip the switch back OFF between this
  // enable and the fetch (the race that served an empty queue → "0/0 despite
  // pending drafts"). Manual-only: auto-start must NOT auto-enable (the panic-stop
  // kill switch stays authoritative for lights-out runs). Record whether the arm
  // actually performed the OFF→ON transition (POST landed AND prior=false) —
  // endRun disarms only a switch this run turned on itself, never the
  // operator's standing dashboard toggle (see RunState.armedSend). Such an arm
  // is ALSO stamped durably (setPendingArm) before anything that can throw, and
  // cleared only once it is accounted for — RunState persisted (endRun owns the
  // disarm from then on) or rolled back OFF after a failed start — so a start
  // that dies between the arm and saveState can never leak the switch ON (see
  // the catch below + the checkAutonomy pending-arm gate). SUPERSESSION
  // HAND-OFF: when this manual start supersedes a live run that armed the
  // switch itself (double-press/restart — the superseded state read below is
  // about to be overwritten by this run's saveState, erasing the only record of
  // that arm), or an unaccounted pending-arm marker stands, this run INHERITS
  // ownership: armedSend=true even though the enable saw prior=true (the
  // predecessor's own flip, not standing consent), so the disarm is never
  // orphaned (see inheritsArmOnSupersede).
  let armedSend = false;
  if (opts?.manual) {
    await withSendSwitch(async () => {
      const superseded = await loadState();
      const inherited = inheritsArmOnSupersede({
        supersededStatus: superseded?.status,
        supersededArmedSend: superseded?.armedSend,
        pendingArm: await getPendingArm(),
      });
      armedSend = (await enableSendForManualRun()) || inherited;
      if (armedSend) await setPendingArm(epoch, Date.now());
    });
  }
  // Hoisted so the pinned tab is available both to the RunState below (inside the
  // try) and to cdp.attach after it. Assigned once the run is committed.
  let tabId: number | null = null;
  try {
    const api = new ActuatorApi(cfg);
    const queue = await api.fetchQueue();
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
      await chrome.storage.local.set({ "actuator.automationStartMs": automationStartMs });
    }
    const warm = warmupCapMultiplier(automationStartMs, startMs);
    // Reddit is REPLY-ONLY: likes/dms caps are hard-zero so the scheduler plans zero
    // like/dm slots, and the daily reply cap is clamped to the Reddit-safe ceiling
    // (default 8) before the warm-up ramp scales it up over ~4 weeks.
    const dailyReplyCap = Math.min(cfg.caps.comments, REDDIT_DEFAULTS.repliesPerDay);
    const effectiveCaps = {
      likes: 0,
      comments: Math.round(dailyReplyCap * warm),
      dms: 0,
    };
    // Belt-and-suspenders: force targetLikes:0 at the planner regardless of caller,
    // so no code path can ever schedule a vote/like slot on Reddit.
    const runParams = { ...params, targetLikes: 0 };

    const { actions: planned } = planTimeline({
      params: runParams, approvedDms: 0, caps: effectiveCaps, startMs,
      deepNightTaper: cfg.deepNightTaper, maxWritesPerHour: cfg.maxWritesPerHour ?? REDDIT_DEFAULTS.maxWritesPerHour, rng,
    });
    const actions: SlotAction[] = planned.map((a) => ({ kind: a.kind, atMs: a.atMs, executed: false }));

    // Pin the run to the tab it starts on. tickOnce passes s.tabId back to
    // findRedditTab, so a permalink/profile tab the operator opens later can never
    // hijack the run; the pin is only re-picked when this tab closes.
    tabId = await findRedditTab();
    const state: RunState = {
      sessionId: crypto.randomUUID(), epoch, startMs, windowHours: params.windowHours, actions,
      persona, warmupSuppressMs, tabId: tabId ?? undefined,
      // Reddit is reply-only: the planner is fed targetLikes:0 + caps.likes/dms:0,
      // so it emits ONLY comment (reply) slots — likes/dms targets are hard 0.
      targets: {
        likes: 0,
        comments: actions.filter((a) => a.kind === "comment").length,
        dms: 0,
      },
      done: { likes: 0, comments: 0, dms: 0 },
      commentPool: queue.comments.map(toPoolItem),
      dmPool: [], // Reddit never DMs.
      upvoteAtMs: [], // idle-upvote timestamps (rolling-15-min ≤10 cap anchor)
      doneDraftIds: [], lastPollMs: startMs, status: "running",
      armedSend, // true iff this manual run flipped reply_send_enabled ON itself
      // Idle-upvote min-gap jitter, drawn ONCE per session (see RunState) — a
      // per-tick redraw would bias the effective gap toward the 60s floor.
      upvoteGapJitter: rng.float(1, 1.8),
    };
    await saveState(state);
    // The arm is now accounted for: RunState carries armedSend, so endRun owns
    // the disarm from here. Inside the serial lock so it can't interleave with
    // checkAutonomy's classify-then-disarm of the same marker (which also runs
    // under the lock and re-reads the marker inside it).
    if (armedSend) await withSendSwitch(() => clearPendingArm(epoch));
  } catch (e) {
    // A throw between the landed arm and the persisted RunState (e.g. a
    // transient api-vm 5xx from fetchQueue) would otherwise LEAK the arm: no
    // RunState means endRun never sees armedSend, autonomous runs never disarm
    // by design, and /api/actionable-reddit gates on reply_send_enabled ONLY —
    // so the next lights-out run would post replies under a consent flag the
    // operator never chose to leave standing. Roll the arm back OFF
    // (best-effort; the durable marker keeps autonomy fail-closed if even the
    // rollback fails) before surfacing the start failure.
    await rollbackArmAfterFailedStart(cfg, epoch, armedSend);
    throw e;
  }

  if (tabId != null) await cdp.attach(tabId).catch(() => {}); // banner appears
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  // chrome.alarms can't fire faster than ~30s; kick a few early ticks so the
  // first action happens within seconds (the SW stays alive right after Run).
  for (const ms of [3500, 8000, 15000, 22000]) setTimeout(() => void tick(), ms);
}

// Map an api.ts EngineQueueItem onto the Reddit pool item, carrying the target
// TYPE (post | comment) + commentId through to doReply.
function toPoolItem(c: EngineQueueItem): RedditPoolItem {
  return Object.assign({
    approvalId: c.approval_id, draftId: c.draft_id, body: c.body,
    url: c.target.url, targetType: c.target.type, commentId: c.target.commentId,
  }, { capturedReply: c.capturedReply });
}

// Drain mode: post ALL approved replies a gap apart (4 min + 0–900s), filling each
// gap with ambient browsing AND operator-opt-in idle-UPVOTES (upvote-only, capped
// ≤10/15min; never a downvote, never a scheduled vote slot). Reuses the whole tick
// engine — it just builds a drain schedule and flags the run mode:"drain" (which
// makes each reply return to the Reddit feed so the gap browses + upvotes the feed).
// Newest post first (the /api/actionable-reddit queue is served newest-first).
// Epoch-based supersede, same as startRun — no warm-up suppression (drain is explicit).
async function startDrain(opts?: { manual?: boolean }) {
  const cfg = await getConfig();
  if (!cfg) throw new Error("not configured");
  // Fresh cancellation handle for this drain. Abort any prior one first so a
  // superseded run's in-flight dwells collapse now instead of lingering.
  runAbort.abort();
  runAbort = new AbortController();
  const epoch = await bumpEpoch();
  // Enable sending after claiming the epoch, before fetchQueue (see startRun) —
  // with the same durable pending-arm stamp + failed-start rollback, so a drain
  // that dies between the landed arm and saveState can never leak the switch ON.
  // And the same supersession hand-off: a drain that supersedes a live run
  // which armed the switch itself (or an unaccounted pending-arm marker)
  // inherits the arm — its saveState is about to erase the predecessor's
  // armedSend record, so ownership of the disarm must move with it (see
  // inheritsArmOnSupersede + the startRun arm block).
  let armedSend = false;
  if (opts?.manual) {
    await withSendSwitch(async () => {
      const superseded = await loadState();
      const inherited = inheritsArmOnSupersede({
        supersededStatus: superseded?.status,
        supersededArmedSend: superseded?.armedSend,
        pendingArm: await getPendingArm(),
      });
      armedSend = (await enableSendForManualRun()) || inherited;
      if (armedSend) await setPendingArm(epoch, Date.now());
    });
  }
  // Hoisted so the pinned tab is available both to the RunState below (inside the
  // try) and to cdp.attach after it. Assigned once the drain is committed.
  let tabId: number | null = null;
  try {
    const api = new ActuatorApi(cfg);
    const queue = await api.fetchQueue();
    const rng = makeRng((Date.now() & 0xffffffff) >>> 0);
    const startMs = Date.now();
    const persona = makeSessionPersona((Date.now() & 0xffffffff) >>> 0);
    // Per-session drain temperament, drawn from its OWN seed (NOT the plan rng, so
    // the plan stream is untouched). Persisted on RunState so every auto-continue
    // round shares the same mood (see maybeExtendDrain). TIMING-ONLY: reddit's drain
    // is reply-only, so the archetype carries only the gap-band mix + optional long
    // break — never a like/vote knob.
    const drainStyle = pickDrainArchetype(makeRng((Date.now() ^ 0x9e3779b1) >>> 0));

    const nComments = queue.comments.length;
    // Reddit drain is REPLY-ONLY: likesPerGap*=0 makes planDrainTimeline emit zero
    // like slots, and we defensively filter to comment slots so no vote can ever be
    // scheduled even if the shared planner changes. drainStyle contributes ONLY the
    // timing knobs (bandWeights + longBreakMs) — it has no like field, so the
    // reply-only invariant holds regardless of the spread order.
    const planned = planDrainTimeline({
      approvedComments: nComments,
      startMs,
      rng,
      shortBandProb: cfg.drainShortBandProb,
      likesPerGapMin: 0,
      likesPerGapMax: 0,
      ...drainStyle,
    }).filter((a) => a.kind === "comment");
    const actions: SlotAction[] = planned.map((a) => ({ kind: a.kind, atMs: a.atMs, executed: false }));
    const lastAt = actions.reduce((m, a) => Math.max(m, a.atMs), startMs);
    const windowHours = (lastAt - startMs) / 3600_000 + 0.15; // pad so the last slot fits

    // Pin the run to the tab it starts on (reused via s.tabId in tickOnce), so a
    // permalink/profile tab the operator opens later can never hijack the drain.
    tabId = await findRedditTab();
    const state: RunState = {
      sessionId: crypto.randomUUID(), epoch, startMs, windowHours, actions,
      persona, drainStyle, warmupSuppressMs: 0, mode: "drain", manualDrain: opts?.manual === true, tabId: tabId ?? undefined,
      targets: { likes: 0, comments: nComments, dms: 0 },
      done: { likes: 0, comments: 0, dms: 0 },
      commentPool: queue.comments.map(toPoolItem),
      dmPool: [],
      upvoteAtMs: [], // idle-upvote timestamps (rolling-15-min ≤10 cap anchor)
      doneDraftIds: [], lastPollMs: startMs, status: "running",
      armedSend, // true iff this manual drain flipped reply_send_enabled ON itself
      // Idle-upvote min-gap jitter, drawn ONCE per session (see RunState) — a
      // per-tick redraw would bias the effective gap toward the 60s floor.
      upvoteGapJitter: rng.float(1, 1.8),
    };
    await saveState(state);

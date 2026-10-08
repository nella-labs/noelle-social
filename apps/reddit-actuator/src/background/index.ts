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
    // The arm is now accounted for: RunState carries armedSend → endRun disarms.
    // Inside the serial lock so it can't interleave with checkAutonomy's
    // classify-then-disarm of the same marker (see startRun).
    if (armedSend) await withSendSwitch(() => clearPendingArm(epoch));
  } catch (e) {
    // Same failed-start leak as startRun: never leave a landed arm standing when
    // the drain aborted before its RunState was persisted (see startRun's catch).
    await rollbackArmAfterFailedStart(cfg, epoch, armedSend);
    throw e;
  }

  if (tabId != null) await cdp.attach(tabId).catch(() => {}); // banner appears
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  for (const ms of [3500, 8000, 15000, 22000]) setTimeout(() => void tick(), ms);
}

// The operator explicitly clicking Run/Drain in the extension IS the consent to
// post, so auto-enable the master reply switch (reply_send_enabled) for this
// instance — approved replies then flow to the queue without the operator ever
// having to flip a dashboard toggle. Deliberately called ONLY when startRun/
// startDrain carry the manual flag (the message-handler path), NOT from the
// unattended auto-start path (checkAutonomy passes no flag), so the global
// panic-stop kill switch (which sets reply_send_enabled=false on every intern)
// stays authoritative for lights-out runs. Best-effort: a failure — e.g. an
// older api-vm without this endpoint — is logged, not fatal, so Run still
// proceeds against whatever the flag already is. Returns whether this run
// actually ARMED the switch — the POST landed AND the server reports the flag
// was OFF before it (prior=false, the OFF→ON transition was ours). Only such an
// arm may be disarmed by endRun / the failed-start rollback: a failed POST means
// the flag is whatever the operator set, and a landed no-op enable against an
// ALREADY-ON flag (prior=true — the operator's standing dashboard consent for
// the documented lights-out workflow) is not ours to flip OFF either. A missing
// prior (older api-vm) is treated as prior=true — fail-safe, never disarm what
// might be standing consent (see armedByManualEnable).
async function enableSendForManualRun(): Promise<boolean> {
  const cfg = await getConfig();
  if (!cfg) return false;
  try {
    const { prior } = await new ActuatorApi(cfg).enableSend(cfg.instanceId, true);
    return armedByManualEnable(prior);
  } catch (e) {
    console.warn("[actuator] could not auto-enable sending:", e instanceof Error ? e.message : e);
    return false;
  }
}

// Roll a LANDED arm back OFF after a manual start failed before persisting its
// RunState (see the try/catch in startRun/startDrain). Serialized through
// withSendSwitch and epoch-guarded exactly like endRun's disarm: if a newer
// Run/Drain already superseded this failed start (bumped the epoch and armed for
// ITS run), the switch — and the pending-arm marker — belong to that run now, so
// this must leave both alone. On a successful disarm the pending-arm marker is
// cleared (the arm is accounted for); on a failed disarm the marker STAYS, which
// keeps checkAutonomy fail-closed (no lights-out start, disarm retried there)
// until the switch is confirmed OFF.
async function rollbackArmAfterFailedStart(
  cfg: ActuatorConfig,
  epoch: number,
  armedSend: boolean,
): Promise<void> {
  if (!armedSend) return;
  await withSendSwitch(async () => {
    if ((await currentEpoch()) !== epoch) return; // superseded — the newer run owns the switch
    try {
      await new ActuatorApi(cfg).enableSend(cfg.instanceId, false);
      await clearPendingArm(epoch);
      console.warn("[actuator] start failed after arming send — rolled reply_send_enabled back OFF");
    } catch (e) {
      console.warn(
        "[actuator] start failed after arming send AND the rollback disarm failed — autonomy stays blocked until the switch is confirmed OFF:",
        e instanceof Error ? e.message : e,
      );
    }
  });
}

async function endRun(status: RunState["status"]) {
  // Abort the live run's in-flight work FIRST. Every pending dwell/motion sleep
  // resolves immediately, so a tick caught mid-action unwinds in ~a frame instead
  // of finishing a tens-of-seconds reading dwell — this is what makes STOP feel
  // instant. The epoch bump below still guarantees it can't save its plan back.
  runAbort.abort();
  // Stamp the challenge day on a challenge halt BEFORE loading run state, so the
  // stamp survives even when loadState() returns null (the auto-start safety gate
  // + backoff read this key next tick, and across service-worker restarts).
  if (status === "halted-challenge") {
    await chrome.storage.local.set({ [CHALLENGE_DAY_KEY]: localDayKey(new Date()) });
  }
  // Bump the epoch FIRST so any tick still in flight (mid-scroll, mid-post) loaded
  // a now-stale epoch and can neither post nor write "running" back over this stop.
  // Then stamp the terminal state with the fresh epoch so it is authoritative.
  const term = await bumpEpoch();
  const s = await loadState();
  if (s) {
    s.status = status;
    s.epoch = term;
    await saveState(s);
    // Detach EVERY tab this run attached (a re-pin after the pinned tab closed
    // attaches more than one, and the re-pin may not be persisted yet), so no
    // debugger session — or its banner — lingers after the run halts.
    await cdp.detachAll();
    // shortfall logging (no silent truncation)
    const cfg = await getConfig();
    if (cfg) {
      const api = new ActuatorApi(cfg);
      // Disarm the master reply switch ONLY when this run armed it (a manual
      // Run/Drain whose enable POST landed — RunState.armedSend), so sending a
      // manual run turned ON is fail-closed at rest, while the operator's
      // standing dashboard toggle survives: autonomous runs never arm, and
      // GET /api/actionable-reddit gates on reply_send_enabled ONLY (no
      // auto_send_enabled lights-out fallback like LinkedIn), so an
      // unconditional disable here would silently starve every later
      // autonomous run.
      //
      // AND only if this run is still current. A manual Run/Drain that
      // superseded us has already bumped the epoch past `term` and re-enabled
      // sending for ITS run; disabling here would race that enable back OFF and
      // empty the new run's queue (the "0/0 despite pending drafts" bug). When
      // superseded, leave the switch alone — the newer run owns it. Serialized
      // with the run-start enable (withSendSwitch) so the check-then-disable
      // can't interleave with an enable.
      await withSendSwitch(async () => {
        if (shouldDisableSendOnRunEnd({ armedSend: s.armedSend, termEpoch: term, curEpoch: await currentEpoch() })) {
          await api.enableSend(cfg.instanceId, false).catch(() => {});
        }
      });
      const events: RedditActivityEvent[] = [];
      const at = new Date(Date.now()).toISOString();
      const miss = shortfall(s.targets.comments, s.done.comments);
      if (miss > 0) events.push({ type: "skip", reason: `shortfall-replies-${miss}`, at });
      if (events.length) await api.logActivity(s.sessionId, events).catch(() => {});
    }
  }
  await chrome.alarms.clear(ALARM);
}

// Drain auto-continue. A drain plans a FIXED number of reply slots (the queue
// size at start), so it used to STOP after that first batch even when the inbox
// still held approvals — the ones capped at start, that arrived mid-run, or that
// were re-queued after a transient failure ("the actuator stopped before
// finishing the approvals inbox"). When every planned slot is done, re-fetch the
// queue and, if pending replies remain, APPEND a fresh batch of reply slots and
// extend the window — so one operator Drain clears the WHOLE inbox without a
// manual re-trigger. Returns true iff it extended (caller keeps the run running).
// Bounded by MAX_DRAIN_ROUNDS. Naturally self-limiting: an empty queue (nothing
// left, or sending disabled server-side) returns false → the drain ends; replies
// that keep failing hit the per-draft retry cap → doneDraftIds → filtered out of
// the next fetch → remaining reaches 0. REPLY-ONLY, like startDrain: the planner
// is fed likesPerGap*=0 and the plan is filtered to comment slots, so an
// extension round can never introduce a vote slot.
async function maybeExtendDrain(
  s: RunState, cfg: ActuatorConfig, api: ActuatorApi, now: number, rng: ReturnType<typeof makeRng>,
): Promise<boolean> {
  if (s.mode !== "drain") return false;
  const q = await api.fetchQueue().catch(() => null);
  if (!q) return false;
  const done = new Set(s.doneDraftIds);
  s.commentPool = mergePool(s.commentPool, q.comments.map(toPoolItem), done) as RedditPoolItem[];
  s.lastPollMs = now; // this fetch counts as a poll; don't double-fetch next tick
  const remaining = s.commentPool.length;
  if (!shouldExtendDrain(s.mode, s.drainRounds ?? 0, remaining)) return false;

  // Plan a fresh drain batch for the remaining replies, starting shortly from
  // now, and splice it onto the timeline. The existing reply-slot executor shifts
  // these off s.commentPool exactly as it did the first batch. Re-plan with the
  // SAME persisted temperament (old states without drainStyle fall back to today's
  // defaults via `?? {}`), so every round keeps one coherent session character.
  const planned = planDrainTimeline({
    approvedComments: remaining,
    startMs: now,
    rng,
    shortBandProb: cfg.drainShortBandProb,
    likesPerGapMin: 0,
    likesPerGapMax: 0,
    ...(s.drainStyle ?? {}),
  }).filter((a) => a.kind === "comment");
  const newLast = planned.reduce((m, a) => Math.max(m, a.atMs), now);
  for (const a of planned) s.actions.push({ kind: a.kind, atMs: a.atMs, executed: false });
  s.windowHours = (newLast - s.startMs) / 3600_000 + 0.15; // extend so the new tail fits
  s.targets.comments += remaining;
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
  // mergePool is the shared engine's PoolItem[] merge; it preserves the item
  // objects (keyed on draftId), so the RedditPoolItem target fields ride through —
  // the cast just re-narrows the widened return. Reddit never DMs, so no dm merge.
  s.commentPool = mergePool(s.commentPool, q.comments.map(toPoolItem), done) as RedditPoolItem[];
}

// Ambient read-actions (expand "…more" / open a post's comments to read) are
// paced by a rolling cooldown so they cluster like real reading instead of
// firing on every ~4s idle tick. Base gap × a 1–2 jitter ⇒ roughly one every
// 20–40s at most; many attempts also find nothing in view and downgrade to a
// scroll, so the real rate is lower. Read-only + non-counted against targets.
// Tightened (was 30s×1–2.5) so the actor actively clicks "…more" while waiting.
const AMBIENT_READ_MIN_GAP_MS = 20_000;

// One ambient browse: pick a behavior (read-actions gated by cooldown + config
// kill switch, default ON) and run it. Advances the cooldown anchor only on an
// action that actually happened, so a downgraded-to-scroll attempt doesn't burn
// the gap. Mutates `s` in place; the caller persists it.
async function ambientBrowse(
  s: RunState,
  cfg: ActuatorConfig,
  tabId: number,
  rng: ReturnType<typeof makeRng>,
  now: number,
): Promise<void> {
  // The idle browse must happen on a feed. This path used to have NO feed guard,
  // so once a scheduled reply (or a mis-landed click) left the tab on a thread
  // permalink or /user page, ambient ticks scrolled/expanded THAT page forever —
  // the loop looked busy while idling on the wrong surface. Re-assert the feed
  // first (shared guard, also used by the idle-upvote path).
  await ensureOnFeed(tabId, rng);
  const readEnabled = cfg.ambientReadActions !== false; // undefined ⇒ ON
  const sinceRead = now - (s.lastAmbientReadMs ?? 0);
  const readActionsAllowed = readEnabled && sinceRead > AMBIENT_READ_MIN_GAP_MS * rng.float(1, 2.6);
  const kind = chooseAmbient(rng, { readActionsAllowed });
  const did = await runAmbient(tabId, kind, {
    cdp, rng, sleep, send, wpm: s.persona.wpm,
    navigate: (id, url) => navigateTab(id, url, rng),
  }).catch(() => null);
  if (did === "expand" || did === "comments") s.lastAmbientReadMs = now;
}

// ── Idle-upvotes (operator opt-in; UPVOTE-ONLY) ──────────────────────────────
// Rolling window over which the ≤10-upvotes hard cap is enforced.
const REDDIT_UPVOTE_WINDOW_MS = 15 * 60_000;

/**
 * May an idle-UPVOTE fire now? Thin wrapper over the pure canUpvoteNow gate:
 *   cfg.upvotesEnabled !== false                               (operator opt-in; DEFAULT ON)
 *   && upvotes in the last 15 min < (cfg.upvotesPer15Min ?? 10)  (rolling hard cap)
 *   && (now - lastUpvote/attempt) > REDDIT_DEFAULTS.upvoteMinGapMs (~60s min-gap,
 *      anchored on the ATTEMPT too — the locateUpvote scan is costly, so a
 *      like-less feed is not re-scanned every ~4s tick)
 * UPVOTE-ONLY — this only ever authorizes an upvote; there is no downvote path.
 */
function canUpvote(s: RunState, cfg: ActuatorConfig, now: number): boolean {
  return canUpvoteNow({
    enabled: cfg.upvotesEnabled !== false,
    inCurfew: isWriteCurfew(now),
    upvoteAtMs: s.upvoteAtMs,
    now,
    cap: cfg.upvotesPer15Min ?? REDDIT_DEFAULTS.upvotesPer15Min,
    windowMs: REDDIT_UPVOTE_WINDOW_MS,
    // Suppress idle-upvotes inside a QUIET drain gap the timing archetype left long
    // (a cooldown-band or long-break gap). Drain only — scheduled runs plan no long
    // "stepped away" gaps to protect. Mirrors LinkedIn's shouldIdleLike inQuietGap.
    inQuietGap: s.mode === "drain" && inQuietDrainGap(s.actions, now),
    // Jitter ×1–1.8 so upvotes don't recur on one metronomic ~60s beat, drawn
    // ONCE at run start (RunState.upvoteGapJitter) — a per-tick redraw would
    // bias the effective gap toward the floor (the gate passes on the first low
    // draw). The multiplier is ≥1: the 60s floor is a safety bound and is never
    // lowered; a pre-upgrade state (undefined) falls back to the floor itself.
    minGapMs: REDDIT_DEFAULTS.upvoteMinGapMs * (s.upvoteGapJitter ?? 1),
    lastAttemptMs: s.lastUpvoteAttemptMs,
  });
}

/**
 * Re-assert a feed before an idle-UPVOTE (ports LinkedIn #410's navigate-to-feed
 * guard). After a scheduled-mode reply the tab parks on the just-replied thread's
 * /comments/ permalink, where locateUpvote would scan that page and target the
 * just-replied post's own upvote button — exactly the systematic reply+upvote
 * pairing fingerprint the actuator must never produce (see the reply-only stance
 * in api.ts). Mirrors the drain-mode return-to-feed: navigate to the feed (old
 * Reddit when the operator opted into preferOldReddit), wait for load, then a
 * short hydration sleep so the first cards have rects. Conservative + best-effort:
 * only a known /comments/ URL triggers the nav, and any failure just falls through
 * — a missed upvote degrades to ambient browse, never an error loop.
 */
async function ensureOnFeedForUpvote(
  tabId: number,
  cfg: ActuatorConfig,
  rng: ReturnType<typeof makeRng>,
): Promise<void> {
  const cur = await chrome.tabs.get(tabId).catch(() => null);
  if (!cur?.url || !/\/comments\//.test(cur.url)) return;
  const feed = cfg.preferOldReddit === true ? "https://old.reddit.com/" : REDDIT_FEED_URL;
  await navigateTab(tabId, feed, rng).catch(() => {});
  await waitTabComplete(tabId);
  await sleep(rng.float(900, 2600)); // let the first cards hydrate
}

/**
 * Upvote ONE feed post like a human: locate a post NOT already upvoted on the feed
 * (locateUpvote) and land a trusted CDP click on its upvote button. Mirrors the
 * LinkedIn likeAFeedPost shape, INCLUDING the read-before-act dwell: the located
 * post's wordCount/hasMedia drive decideStop → readingDwellMs | glanceMs, so an
 * upvote follows a human read (a stop-and-read or a quick glance), not a flat beat.
 * UPVOTE-ONLY — locateUpvote returns only the upvote button; there is deliberately
 * NO downvote path. Returns whether an upvote landed plus the observed post
 * id/subreddit; the caller records the timestamp + logs {type:"upvote"}.
 */
async function doUpvote(
  tabId: number,
  rng: ReturnType<typeof makeRng>,
  wpm: number,
): Promise<{ ok: boolean; post_id?: string; subreddit?: string }> {
  // An idle-upvote must run ON a feed — off the feed, locateUpvote still matches
  // the odd shreddit-post card (a /user profile, a thread permalink), so the
  // upvote lands on the wrong surface. Pull the tab back first (shared guard,
  // also used by the ambient browse). Best-effort — a failed nav just falls
  // through to the locate below.
  await ensureOnFeed(tabId, rng);
  const loc = await send<LocateResult>(tabId, { cmd: "locateUpvote" }).catch(() => null);
  if (!loc?.ok || loc.x == null) return { ok: false };
  // Read the post like a human BEFORE upvoting: a stop-and-read dwell proportional
  // to its length, or a quick glance when scrolling past (decideStop). Replaces the
  // flat 400–2000ms beat with the LinkedIn read-before-like pattern. Uses the
  // abortable `sleep` (from stage B) so a STOP mid-read collapses the dwell and the
  // upvote is never landed.
  const wc = typeof loc.observed?.wordCount === "number" ? loc.observed.wordCount : 0;
  const media = loc.observed?.hasMedia === true;
  const stop = decideStop(rng, wc, { hasMedia: media });
  await sleep(stop ? readingDwellMs(rng, wc, { hasMedia: media }, wpm) : glanceMs(rng));
  // Re-locate immediately before clicking. The rect captured before the read
  // goes STALE: Reddit's infinite scroll inserts/lazy-loads cards above it and
  // shifts the vote column — so the pre-read coordinates can land in the post
  // BODY, which opens the permalink (off-feed) AND misses the upvote. Click a
  // freshly-measured rect; fall back to the pre-read one only on a miss.
  let clickLoc: LocateResult = loc;
  const fresh = await send<LocateResult>(tabId, { cmd: "locateUpvote" }).catch(() => null);
  if (fresh?.ok && fresh.x != null) clickLoc = fresh;
  throwIfAborted(runAbort.signal); // STOP during the read/re-locate → don't land the upvote
  await cdp.moveAndClick(tabId, rectFrom(clickLoc), rng, sleep);
  const post_id = typeof clickLoc.observed?.post_id === "string" ? clickLoc.observed.post_id : undefined;
  const subreddit = typeof clickLoc.observed?.subreddit === "string" ? clickLoc.observed.subreddit : undefined;
  return { ok: true, post_id, subreddit };
}

// Live-browser deps for engageWithVariety (src/background/engage.ts — the
// orchestration is a plain function over these primitives so its
// fall-back-to-upvote + Escape-dismiss discipline is unit-tested; only this
// wiring touches chrome.* / CDP). The plain-upvote path (and every save
// fall-back) is the SAME doUpvote used by the upvote-only path, so a save
// consumes no extra velocity — the caller's canUpvote gate is the single budget.
function engageDeps(tabId: number, rng: ReturnType<typeof makeRng>, wpm: number): EngageDeps {
  return {
    upvote: () => doUpvote(tabId, rng, wpm),
    // Re-assert the feed before scanning for a saveable post (mirrors doUpvote's
    // own first line) so a save never lands on a /user profile or permalink card.
    locateSave: async () => {
      await ensureOnFeed(tabId, rng);
      return send<EngageLocate>(tabId, { cmd: "locateSave" });
    },
    locateSaveItem: () => send<EngageLocate>(tabId, { cmd: "locateSaveInMenu" }),
    click: (rect) => cdp.moveAndClick(tabId, rect, rng, sleep),
    dismissMenu: () => cdp.pressEscape(tabId),
    sleep,
  };
}

// Serialize ticks so the content-script-driven loop can't overlap with the
// alarm-driven one (overlap would double-read/write state).
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await tickOnce();
  } finally {
    ticking = false;
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

  const tabId = await findRedditTab(s.tabId);
  if (tabId == null) return; // no tab → pause; resume next tick
  if (s.tabId !== tabId) s.tabId = tabId; // pin (or re-pin after the old tab closed)
  await cdp.attach(tabId).catch(() => {}); // idempotent; re-attach if a detach happened

  const api = new ActuatorApi(cfg);
  const rng = makeRng((now & 0xffffffff) >>> 0);
  await maybeReplenish(s, api, now, rng);

  // challenge guard — only a HARD challenge (verify/lock/throttle) halts; the
  // transient JS-challenge reports challenge:false and is waited out.
  const ch = await send<{ observed?: ChallengeResult }>(tabId, { cmd: "detectChallenge" }).catch(() => null);
  if (ch?.observed?.challenge) {
    await endRun("halted-challenge");
    await api.logActivity(s.sessionId, [{ type: "skip", reason: "challenge", at: new Date(now).toISOString() }]).catch(() => {});
    return;
  }

  const idx = dueActionIndex(s.actions, now);
  if (idx < 0) {
    // Persistent drain: when every slot is done, keep re-checking the server queue
    // (paced, ~DRAIN_WATCH_POLL_MS) so approvals made after the inbox emptied get
    // fresh slots and go out with no re-click. maybeExtendDrain appends slots +
    // bumps drainRounds only when supply exists; an empty check is a no-op.
    if (
      drainShouldKeepWaiting(s.mode, s.drainRounds ?? 0) &&
      s.actions.every((a) => a.executed) &&
      now - (s.lastDrainWatchMs ?? 0) >= DRAIN_WATCH_POLL_MS
    ) {
      s.lastDrainWatchMs = now;
      await maybeExtendDrain(s, cfg, api, now, rng);
    }

    // SUPPLY GATE: with nothing to send (both pools empty) a live run goes QUIET —
    // no idle-likes, no ambient browsing. Without this, a run whose pipeline had
    // run dry still burned engagement every tick: 2026-07-20 Lyra logged 346 likes
    // against 3 comments in a day, 359/43 the day before. The watch-poll above
    // still runs, so the moment an approval lands the run picks it up and the
    // normal in-gap liking resumes.
    if (pipelineIsDry(s.commentPool.length, s.dmPool.length)) {
      s.lastEvent = "nothing to send — idle (no likes while the pipeline is empty)";
      await saveIfCurrent(s);
      return;
    }
    // Nothing due. Mirror the LinkedIn idle-like path: slip an idle ENGAGEMENT into
    // the wait when the operator opted in and the rolling-15-min cap + ~60s min-gap
    // allow (canUpvote), otherwise ambient-browse (scroll + read decoys). Idle-only,
    // rate-capped — there are NO scheduled like/vote slots (targetLikes stays 0).
    // The engagement is ALMOST ALWAYS a plain UPVOTE; when the operator opts into
    // engagementWeights it is OCCASIONALLY a post-SAVE (a private bookmark — NOT a
    // vote, so it never touches the vote-manipulation clause a downvote would). A
    // save consumes the SAME canUpvote budget as an upvote (canUpvote is the shared
    // gate — no extra velocity), and FALLS BACK to a plain upvote on any miss.
    // A missed engagement (nothing in view) falls back to ambient browse so the
    // wait still looks alive. SAVE-ONLY — never a downvote.
    let engaged = false;
    if (canUpvote(s, cfg, now)) {
      s.lastUpvoteAttemptMs = now; // pace off the attempt, not just a hit (the scan is costly)
      // Never engage from a /comments/ permalink (the just-replied thread) — pull
      // the tab back to a feed first so the engagement lands on unrelated content.
      await ensureOnFeedForUpvote(tabId, cfg, rng).catch(() => {});
      const eng = await engageWithVariety(cfg.engagementWeights, rng, engageDeps(tabId, rng, s.persona.wpm))
        .catch(() => ({ ok: false as const }));
      if (eng.ok) {
        engaged = true;
        const saved = eng.engagement === "save";
        // Record the successful engagement against the SHARED upvote budget (a save
        // is idle-only, exactly like an upvote), then trim to the rolling window so
        // the array can't grow unbounded and the ≤10/15-min cap + min-gap read a
        // bounded set.
        (s.upvoteAtMs ??= []).push(now);
        s.upvoteAtMs = s.upvoteAtMs.filter((t) => t > now - REDDIT_UPVOTE_WINDOW_MS);
        const inWin = upvotesInWindow(s.upvoteAtMs, now, REDDIT_UPVOTE_WINDOW_MS);
        const cap = cfg.upvotesPer15Min ?? REDDIT_DEFAULTS.upvotesPer15Min;
        s.lastEvent = `${saved ? "saved" : "upvoted"} a post (${inWin}/${cap} in 15m)`;
        await api.logActivity(s.sessionId, [{
          // The activity TYPE stays "upvote" (the idle-engagement primitive that
          // consumed the budget); the optional `engagement` discriminator is added
          // ONLY for a save, so the default upvote-only payload is byte-identical.
          type: "upvote", at: new Date(now).toISOString(),
          ...(saved ? { engagement: "save" as const } : {}),
          ...(eng.post_id ? { post_id: eng.post_id } : {}),
          ...(eng.subreddit ? { subreddit: eng.subreddit } : {}),
        }]).catch(() => {});
      }
    }
    if (!engaged) await ambientBrowse(s, cfg, tabId, rng, now);
    // STOP race: a stop/halt may have landed during the (now longer) engagement /
    // ambient read — don't resurrect the run by writing "running" back over it.
    const cur = await loadState();
    if (cur && cur.status !== "running") return;
    const nextAt = Math.min(...s.actions.filter((a) => !a.executed).map((a) => a.atMs));
    const inSec = Number.isFinite(nextAt) ? Math.max(0, Math.round((nextAt - now) / 1000)) : 0;
    if (!engaged) s.lastEvent = `browsing — next action in ~${inSec}s`;
    await saveIfCurrent(s);
    return;
  }

  const action = s.actions[idx]!;
  const events: RedditActivityEvent[] = [];
  const at = new Date(now).toISOString();
  const windowEndMs = s.startMs + s.windowHours * 3600_000;
  const isWrite = action.kind === "comment"; // Reddit plans ONLY reply slots — never like/dm

  // Overnight write-curfew hard floor (single switch in ../lib/curfew.ts). It is
  // currently DISABLED — isWriteCurfew always returns false, so this never fires
  // and writes run at any hour; re-enable there to restore the overnight window.
  if (isWrite && isWriteCurfew(now)) {
    const d = deferLater(action, now, windowEndMs, rng);
    action.atMs = d.atMs;
    events.push({ type: "skip", reason: "curfew", at });
    s.lastEvent = "curfew — deferred the reply";
    await saveIfCurrent(s);
    await api.logActivity(s.sessionId, events).catch(() => {});
    return;
  }

  // Warm-up: for the first warmupSuppressMs of the session, no writes — arrive,
  // scroll, and read first (a human doesn't fire the instant they land). Defer
  // the slot, run a short ambient browse, then skip.
  if (isWrite && now - s.startMs < s.warmupSuppressMs) {
    const d = deferLater(action, now, windowEndMs, rng);
    action.atMs = d.atMs;
    await ambientBrowse(s, cfg, tabId, rng, now);
    // STOP race during the (now longer) warm-up read.
    const cur = await loadState();
    if (cur && cur.status !== "running") return;
    events.push({ type: "skip", reason: "warming-up", at });
    s.lastEvent = "warming up — reading first";
    await saveIfCurrent(s);
    await api.logActivity(s.sessionId, events).catch(() => {});
    return;
  }

  // STOP (or a superseding Run) may have landed during the awaits above
  // (replenish, challenge probe). Re-check the epoch before touching Reddit so
  // a just-stopped run never fires one last action.
  if (myEpoch !== (await currentEpoch())) return;

  // Reddit min-reply-spacing hard floor (default 240s / 4 min). Scheduled runs
  // only — drain is an explicit "post everything now" operator action. A reply
  // that would land too soon after the previous one is deferred to the floor (plus
  // a little jitter), never fired.
  if (s.mode !== "drain" && !replySpacingOk(s.lastReplyMs, now, REDDIT_DEFAULTS.minReplySpacingMs)) {
    const nextAt = (s.lastReplyMs ?? now) + REDDIT_DEFAULTS.minReplySpacingMs + Math.round(rng.float(0, 60_000));
    action.atMs = Math.min(windowEndMs, nextAt);
    events.push({ type: "skip", reason: "min-spacing", at });
    s.lastEvent = "spacing replies (240s floor)";
    await saveIfCurrent(s);
    await api.logActivity(s.sessionId, events).catch(() => {});
    return;
  }

  try {
    // Reddit is REPLY-ONLY: the single write action is a reply (under a post or a
    // comment). There is deliberately NO like/vote branch anywhere.
    const item = s.commentPool.shift();
    if (!item) {
      // supply-aware: defer this slot later in the window, do NOT execute
      const d = deferLater(action, now, windowEndMs, rng);
      action.atMs = d.atMs;
      events.push({ type: "skip", reason: "reply-awaiting-supply", at });
    } else if (postDedupKey(item.url) && (s.actionedKeys ?? []).includes(postDedupKey(item.url)!)) {
      // Per-THREAD guard: already replied in this thread this session. Orion can
      // queue >1 draft for one thread (a post-target and a comment-target, or two
      // comment targets), and two comments by one account in one thread is a
      // classic subreddit-ban trigger. Keyed on the t3 post id (postDedupKey) so
      // cosmetically-different permalinks still collapse. The server's persistent
      // dedup-by-thread covers the cross-session case; this is the fast in-run
      // guard. Drop the extra draft (mark done), never post it.
      s.doneDraftIds.push(item.draftId);
      action.executed = true;
      events.push({ type: "skip", reason: "duplicate-post", at });
      s.lastEvent = "skipped duplicate thread — already replied";
    } else {
      const outcome = await doReply(tabId, item, cfg, rng, s.persona.wpm);
      if (outcome.kind === "ok") {
        // Record success LOCALLY FIRST, PERSIST it, THEN tell the server. A
        // markSent failure can no longer cost us the local record — which would
        // re-queue this still-pending approval and post a DUPLICATE comment.
        recordReplySuccess(s, action, item, now);
        // Stamp the thread's t3 post id onto the reply event. This is the durable
        // dedup-by-thread record (ports #420): written at post time via this
        // logActivity call — independent of markSent — so it survives a failed
        // markSent, and /api/actionable-reddit filters future pulls against it so
        // this thread is never replied to again.
        const tid = postIdFrom(item.url);
        events.push({
          type: "reply", at,
          approval_id: item.approvalId,
          ...(tid ? { post_id: tid } : {}),
          ...(item.commentId ? { comment_id: item.commentId } : {}),
        });
        s.lastEvent = `replied (${s.done.comments}/${s.targets.comments})`;
        await saveIfCurrent(s); // durable before the network call
        // markSent with retry/backoff; a persistent failure is logged, never thrown.
        await markSentWithRetry(api, item.approvalId, s.sessionId, rng, sleep);
        // Drain mode: return to the feed after replying so the gap's ambient
        // browsing lands on content, not the just-replied thread's page.
        if (s.mode === "drain") await navigateTab(tabId, REDDIT_FEED_URL, rng).catch(() => {});
      } else if (outcome.kind === "unknown") {
        recordReplyHold(s, action, item);
        s.lastEvent = "reply outcome unknown — held without retry";
        await saveIfCurrent(s);
        events.push({ type: "skip", reason: `reply-unknown:${outcome.detail}`, at,
          approval_id: item.approvalId, ...(postIdFrom(item.url) ? { post_id: postIdFrom(item.url)! } : {}) });
      } else if (outcome.kind === "removed") {
        // The target thread can NEVER take this reply — the post is gone
        // (removed/deleted/unavailable), its comments are locked, or it is
        // archived. doReply never opened the composer. Skip it as a TERMINAL
        // outcome: consume the slot, remember the draft so replenish can't
        // re-queue this dead post this session (do NOT unshift it back), and do
        // NOT defer/retry or markSent. The cause-specific reason rides into the
        // skip event AND the server-side skip below.
        events.push(recordRemovedSkip(s, action, item, at, outcome.reason));
        s.lastEvent = `skipped ${outcome.reason} — left it, next`;
        // Also mark it skipped SERVER-SIDE so the queue stops re-serving this
        // permalink on every FUTURE run. The local drop only lasts the session;
        // the approval otherwise stays 'pending' forever (markSent never fires
        // for a thread that can't take the reply), so each new run re-navigates
        // to it and drops it again. Best-effort: a failure just means it's
        // re-served next session, same as before.
        //
        // GATED on `durable`: markSkipped irreversibly flips a human-approved
        // pending approval to 'skipped', so it requires POSITIVE removal/lock
        // evidence (removed attr, thing-deleted, matched phrase, locked/archived
        // signal). A non-durable outcome ('post-unavailable' — the post shell
        // merely absent, which transient 5xx/CDN interstitials also produce)
        // stays a session-local drop that self-heals next run.
        if (outcome.durable) await api.markSkipped(item.approvalId, outcome.reason).catch(() => {});
        // LEAVE the dead post's page — ALWAYS (not just drain). Otherwise the
        // inter-action ambient browsing and the next tick sit on the removed
        // post's page ("browsing" stuck on a gone thread). Return to the feed so
        // idle activity + the next action land on real content.
        await navigateTab(tabId, REDDIT_FEED_URL, rng).catch(() => {});
      } else {
        // Transient failure. Two changes from the old `unshift` (retry at the
        // FRONT, forever): (1) name the failing stage in the skip reason + attach
        // the thread's t3 post id, so reddit_activity says WHY and on WHICH
        // thread — the old bare `reply-failed` was undiagnosable; (2) cap
        // per-draft retries and re-queue at the BACK, so one thread the composer/
        // submit can't handle (or a live throttle) can no longer be retried every
        // slot and starve every other pending draft. "removed" stays exempt from
        // the counter — it is already terminal above.
        const { tries, giveUp } = retryDecision(item.tries ?? 0);
        item.tries = tries;
        const stage = outcome.detail ? `:${outcome.detail}` : "";
        const skip: RedditActivityEvent = {
          type: "skip",
          reason: giveUp ? `reply-failed:gave-up-after-${tries}${stage}` : `reply-failed${stage}`,
          at,
        };
        const pid = postIdFromUrl(item.url);
        if (pid) skip.post_id = pid;
        if (giveUp) {
          // Drop the draft for this session (mark done locally, do NOT markSent —
          // nothing posted) so it stops monopolizing reply slots. The approval
          // stays 'pending'; a later session re-serves it fresh.
          s.doneDraftIds.push(item.draftId);
          action.executed = true;
        } else {
          s.commentPool.push(item); // BACK of the queue — let healthy drafts go first
          const d = deferLater(action, now, windowEndMs, rng);
          action.atMs = d.atMs;
        }
        events.push(skip);
      }
    }
  } catch (e) {
    // A STOP that unwound an in-flight action surfaces as AbortError — log it as a
    // clean "stopped" skip, not a scary error string (and don't page the doctor).
    const reason = isAbortError(e) ? "stopped" : `err:${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`;
    events.push({ type: "skip", reason, at });
    // Mirror real errors (not clean stops) to the Chrome Bridge sink so the doctor
    // can see selector drift / attach failures without DevTools open (observability only).
    if (!isAbortError(e)) sinkLog("error", "tick action failed", { reason });
  }

  // Surface the outcome to the panel (DevTools can't be open during a run).
  const last = events[events.length - 1];
  if (last) {
    s.lastEvent =
      last.type === "reply" ? `replied (${s.done.comments}/${s.targets.comments})`
      : last.reason === "post-removed" ? "skipped removed post — next"
      : last.reason === "post-unavailable" ? "skipped unavailable page — next"
      : last.reason === "comments-locked" ? "skipped locked thread — next"
      : last.reason === "post-archived" ? "skipped archived post — next"
      : `skip: ${last.reason ?? "?"}`;
  }

  // Drain auto-continue: before ending a finished drain, try to append another
  // batch for any approvals still in the inbox, so one Drain clears it all.
  if (s.mode === "drain" && s.actions.every((a) => a.executed)) {
    const extended = await maybeExtendDrain(s, cfg, api, now, rng); // appends non-executed slots when work remains
    // Persistent drain: an empty inbox does NOT end the run. Keep it alive and
    // watching (roll the window, arm the next watch-poll) so a reply approved
    // later goes out with no re-click. Only STOP, a challenge halt, or the batch
    // ceiling (drainShouldKeepWaiting=false) end a drain now.
    if (!extended && drainShouldKeepWaiting(s.mode, s.drainRounds ?? 0)) {
      s.windowHours = (now - s.startMs) / 3600_000 + DRAIN_WATCH_WINDOW_H;
      s.lastDrainWatchMs = now;
      s.lastEvent = "inbox clear — watching for new approvals (no re-click needed)";
    }
  }

  // A caught-up persistent drain stays "running" (watching); every other finished
  // run goes idle and is ended below.
  if (s.actions.every((a) => a.executed) && !drainShouldKeepWaiting(s.mode, s.drainRounds ?? 0)) {
    s.status = "idle";
  }
  // Persist only if we're still the live run. A STOP or a superseding Run that
  // landed mid-tick bumped the epoch, so saveIfCurrent drops this write instead
  // of resurrecting a run that was already stopped/replaced.
  const saved = await saveIfCurrent(s);
  await api.logActivity(s.sessionId, events).catch(() => {});
  if (saved && s.status === "idle") await endRun("idle");
}

// The outcome of one reply attempt:
//   "ok"      → positively-confirmed reply posted (markSent + count).
//   "removed" → the target thread can NEVER take this reply: the post is GONE
//               (removed/deleted/unavailable), its comments are LOCKED, or it is
//               ARCHIVED. SKIP it WITHOUT replying and do NOT retry — never open
//               the composer. `reason` names the cause (post-removed |
//               post-unavailable | comments-locked | post-archived) for the skip
//               event + markSkipped. `durable` says whether the cause was
//               POSITIVELY confirmed (removed attr / matched phrase / locked or
//               archived signal) — only then may the tick markSkipped the
//               approval server-side; 'post-unavailable' (shell absent, could be
//               a transient interstitial) is durable:false → session-local only.
//   "failed"  → a known preparation miss before reservation; capped safe retry.
//   "unknown" → a reservation may exist or submit may have happened. Retain the
//               thread and draft locally, without success metrics or replay.
type ReplyOutcome =
  | { kind: "ok" }
  | { kind: "removed"; reason: string; durable: boolean }
  | { kind: "unknown"; detail: string }
  | { kind: "failed"; detail?: string };

// Post one approved reply via trusted CDP input: navigate → (challenge gate) →
// (removed-post gate) → open the composer → type → submit → CONFIRM the composer
// cleared. Handles the new-Reddit collapsed composer (must be clicked to expand the
// 0×0 editable) and the old-Reddit always-visible textarea, and both target types
// (reply under the POST vs under a specific COMMENT — the latter scoped by commentId
// end to end). Preparation misses return "failed". After reservation, missing or
// unreadable confirmation returns "unknown" and is held. Returns "removed" when the target
// thread is gone — a distinct, no-retry SKIP that never types into a dead post.
/**
 * The reply body this run most recently typed into a composer. The unscoped
 * clear (navigateTab hops, which carry no item) compares against it to tell OUR
 * leftover reply from a comment the operator is writing — new Reddit persists
 * comment drafts, so the difference is between discarding our own dead text and
 * destroying theirs. Undefined until the run types something, which is exactly
 * when there is nothing of ours to clear.
 */
let lastTypedBody: string | undefined;

/**
 * Empty the reply box and confirm it, so the next navigation cannot raise a
 * `beforeunload` dialog.
 *
 * Reddit registers a `beforeunload` handler while the composer holds un-sent
 * text. The actuator's next `chrome.tabs.update` — the hop to the next thread,
 * or the return to the feed — then navigates away from that dirty box and
 * Chromium raises "Leave site? Changes you made may not be saved." The dialog
 * blocks the renderer, freezes the content script's tick loop, and wedges the
 * run until a human clicks it. It cannot be answered over CDP either: handling
 * `beforeunload` via Page.handleJavaScriptDialog is broken upstream
 * (puppeteer/puppeteer#9871), so removing the TRIGGER is the only fix.
 *
 * Never throws — it runs on paths that already decided the draft's fate.
 */
async function clearComposer(tabId: number, item: RedditPoolItem | undefined, rng: ReturnType<typeof makeRng>): Promise<void> {
  // Two modes, because the two callers know different things.
  //
  //  - doReply's own failure path passes the item, so the clear is SCOPED to the
  //    composer it typed into. That is the precise thing to empty.
  //  - navigateTab has no item — it clears before hops that were never part of a
  //    reply. There the question is not "where would a reply be typed" but
  //    "which box on this page is holding text", and those have different
  //    answers: unscoped, locateReplyBox returns the first VISIBLE editable,
  //    which on new Reddit is the page-level "Add a comment" POST composer.
  //    Collapsed it is 0x0 and skipped, but once the operator has expanded it an
  //    empty post box outranks a reply composer that still holds text — the
  //    emptiness check would read the wrong box, report nothing to clear, and
  //    the navigation would raise the dialog anyway. locateDirtyReplyBox asks
  //    the question that has only one answer.
  const scope = item?.commentId;
  const cleared = await runClearComposer(
    item
      ? {
        focusBox: async () => {
          const box = await send<LocateResult>(tabId, { cmd: "locateReplyBox", commentId: scope }).catch(() => null);
          if (!box?.ok || box.x == null) return false;
          await cdp.moveAndClick(tabId, rectFrom(box), rng, sleep);
          return true;
        },
        clearKeys: () => cdp.clearFocusedEditor(tabId, sleep),
        isEmpty: async () => {
          const st = await send<{ observed?: { present?: boolean; empty?: boolean } }>(
            tabId, { cmd: "readReplyBox", commentId: scope },
          ).catch(() => null);
          if (!st) return false;
          return st.observed?.present === false || st.observed?.empty === true;
        },
        sleep,
      }
      : {
        focusBox: async () => {
          if (!lastTypedBody) return false;
          // scroll:true — this one is about to click, so the box must be in view.
          const box = await send<LocateResult>(
            tabId, { cmd: "locateDirtyReplyBox", scroll: true, ownBody: lastTypedBody },
          ).catch(() => null);
          if (!box?.ok || box.x == null) return false;
          await cdp.moveAndClick(tabId, rectFrom(box), rng, sleep);
          return true;
        },
        clearKeys: () => cdp.clearFocusedEditor(tabId, sleep),
        // "Nothing here for US to clear" — either no composer on the page holds
        // text at all, or the one that does is not the reply this run typed.
        //
        // The ownership half matters as much as the emptiness half.
        // locateDirtyReplyBox answers page-wide, so on an ambient or
        // ensureOnFeed hop the dirty box it finds can easily be a comment the
        // operator is part-way through writing — and new Reddit PERSISTS comment
        // drafts, so clearing it destroys their text rather than discarding
        // something the navigation would have dropped anyway. Same rule the
        // LinkedIn half applies to the messaging overlay.
        //
        // A read error is "not confirmed", never a false empty. scroll:false —
        // this runs in a poll loop and must not drag the viewport around.
        isEmpty: async () => {
          if (!lastTypedBody) return true; // this run has typed nothing — nothing of ours
          // ownBody makes the SEARCH ownership-aware rather than filtering its
          // single answer afterwards. Asking for "any dirty box" and then
          // comparing would stop at the operator's own text whenever theirs
          // sorts first — the expanded page-level composer sits above every
          // comment composer — and report "nothing to clear" while OUR reply sat
          // further down, arming the dialog with nothing logged.
          const box = await send<LocateResult>(
            tabId, { cmd: "locateDirtyReplyBox", scroll: false, ownBody: lastTypedBody },
          ).catch(() => null);
          if (!box) return false; // unreadable → not confirmed
          return box.observed?.present !== true;
        },
        sleep,
      },
  );
  // Confirmed independently of the return value. runClearComposer reports
  // success when the box cannot be FOCUSED, on the reasonable assumption that
  // an unfocusable box is an absent one — but a composer can also be present,
  // dirty and unfocusable (hidden ⇒ zero rect, which the locator rightly
  // refuses rather than clicking the viewport corner). Trusting the return
  // there would swallow the warning for the one state that still arms the
  // dialog.
  //
  // The probe MATCHES THE BRANCH. The unscoped clear asks the page-wide
  // question it was given; the scoped clear asks about the composer it was
  // actually pointed at. Using the page-wide probe for both would warn on a
  // perfectly successful scoped clear whenever some unrelated box (an expanded
  // post composer, say) happened to be dirty — poisoning the reddit_activity
  // diagnostic this whole change exists to make trustworthy.
  const stillDirty = item
    ? await send<{ observed?: { present?: boolean; empty?: boolean } }>(
      tabId, { cmd: "readReplyBox", commentId: scope },
    ).then((st) => st?.observed?.present === true && st?.observed?.empty === false).catch(() => false)
    : !lastTypedBody
      ? false
      : await send<LocateResult>(
        tabId, { cmd: "locateDirtyReplyBox", scroll: false, ownBody: lastTypedBody },
      ).then((box) => box?.observed?.present === true).catch(() => false);
  if (!cleared || stillDirty) {
    sinkLog("warn", "composer would not clear; next navigation may raise a leave-site dialog", { tabId });
  }
}

/**
 * Every navigation this actuator makes. Binds the shared clear-then-navigate
 * helper (see makeNavigateTab for why the clear belongs at the navigation and
 * not only on the failure path) to Orion's composer.
 *
 * Declared as a `function` deliberately: ensureOnFeed calls it a thousand lines
 * above clearComposer's definition, which only hoisting makes legal.
 */
function navigateTab(tabId: number, url: string, rng: ReturnType<typeof makeRng>): Promise<void> {
  return makeNavigateTab({
    clearComposer: (id) => clearComposer(id, undefined, rng),
    updateTab: async (id, u) => {
      await chrome.tabs.update(id, { url: u });
    },
  })(tabId, url);
}

/**
 * Wrapper around the real reply flow: a reply that did NOT land must not leave
 * its text in the box (see clearComposer). `finally` rather than a check on the
 * result, so a STOP unwinding mid-flow is covered too.
 */
async function doReply(
  tabId: number,
  item: RedditPoolItem,
  cfg: ActuatorConfig,
  rng: ReturnType<typeof makeRng>,
  wpm: number,
): Promise<ReplyOutcome> {
  let res: ReplyOutcome | undefined;
  try {
    res = await doReplyInner(tabId, item, cfg, rng, wpm);
    return res;
  } finally {
    if (res?.kind !== "ok") await clearComposer(tabId, item, rng);
    // A LANDED reply must be forgotten immediately. On old.reddit the operator
    // can click "edit" on the comment Orion just posted, which makes a textarea
    // holding EXACTLY that text visible — so a later hop's unscoped clear would
    // match it as "ours" and wipe their edit box. The hidden-prefill filter does
    // not help there, because editing is precisely what makes it visible. Once
    // the reply has left our composer the token has no job left anyway.
    //
    // A FAILED one is kept on purpose: the scoped clear above may itself have
    // failed, and then our text really is still sitting in a box that a later
    // hop should be allowed to empty.
    if (res?.kind === "ok") lastTypedBody = undefined;
  }
}

async function doReplyInner(
  tabId: number,
  item: RedditPoolItem,
  cfg: ActuatorConfig,
  rng: ReturnType<typeof makeRng>,
  wpm: number,
): Promise<ReplyOutcome> {
  // 1. Navigate to the target (new Reddit by default; rewrites www→old.reddit.com
  // only when the operator explicitly opts into preferOldReddit) + read.
  const url = targetUrl(item.url, cfg.preferOldReddit === true);
  await navigateTab(tabId, url, rng);
  await waitTabComplete(tabId);
  await sleep(readingDwellMs(rng, Math.max(0, Math.round(rng.normal(60, 40))), {}, wpm));

  // 2. Hard-challenge gate right after navigation — bail (the loop halts next tick).
  const ch = await send<{ observed?: ChallengeResult }>(tabId, { cmd: "detectChallenge" }).catch(() => null);
  if (ch?.observed?.challenge) return { kind: "failed", detail: "challenge-gate" };

  // 2b. Removed-post gate: if the target thread was removed/deleted/unavailable,
  // SKIP it here — BEFORE locating or opening any composer — so we never type a
  // reply into a dead post ("Sorry, this post was removed by Reddit's filters.").
  // classifyRemovedProbe splits CONFIRMED removal (positive attr/phrase evidence
  // → durable, may markSkipped) from a merely-absent post shell (transient
  // 5xx/interstitial states too → session-local drop only).
  const rem = await send<RemovedProbe>(tabId, { cmd: "checkPostRemoved" }).catch(() => null);
  const removedOutcome = classifyRemovedProbe(rem);
  if (removedOutcome) return removedOutcome;

  // 2c. Locked/archived gate: the post renders fine but its comments are locked
  // (or the post is archived — "New comments cannot be posted"), so no composer
  // will EVER render. Permanent for this thread: skip it exactly like a removed
  // post (drop + markSkipped) instead of dying in the reply-box retry loop that
  // re-serves the same permalink forever. The cause rides in the reason
  // (comments-locked | post-archived).
  // Always durable: isCommentsUnavailable only trips on POSITIVE signals (the
  // locked/archived attribute or class, or a banner-chrome-scoped phrase).
  const lock = await send<{ blocked?: boolean; reason?: string }>(tabId, { cmd: "checkCommentsLocked" }).catch(() => null);
  if (lock?.blocked) return { kind: "removed", reason: lock.reason ?? "comments-locked", durable: true };

  // For a COMMENT target, every downstream locate is SCOPED to this comment id so
  // we act on the right comment's composer, never the page-level post box.
  const scope = item.targetType === "comment" ? item.commentId : undefined;

  // 3. Open the composer.
  if (item.targetType === "comment") {
    const btn = await send<LocateResult>(tabId, { cmd: "locateCommentReplyButton", commentId: item.commentId });
    if (!btn.ok || btn.x == null) return { kind: "failed", detail: btn.skipReason ?? "reply-button-not-found" };
    // Never post to an UNVERIFIED target: the located node's id MUST match the
    // intended comment. (The locator already returns ok:false when a provided id
    // matches nothing; this is defense-in-depth against a stale content script.)
    if (!locatedCommentMatches(btn.observed, item.commentId)) return { kind: "failed", detail: "target-mismatch" };
    await cdp.moveAndClick(tabId, rectFrom(btn), rng, sleep);
    await sleep(rng.float(500, 1200)); // the reply composer mounts near the comment
  } else {
    const entry = await send<LocateResult>(tabId, { cmd: "locateComposerEntry" });
    if (!entry.ok || entry.x == null) return { kind: "failed", detail: entry.skipReason ?? "composer-entry-not-found" };
    await cdp.moveAndClick(tabId, rectFrom(entry), rng, sleep); // focus / expand
    if (entry.observed?.needsExpand === true) await sleep(rng.float(400, 1000)); // editable expands to a non-zero rect
  }

  // 4. Poll for the reply box to become READY (non-zero rect), then type + submit.
  let box: LocateResult | null = null;
  for (let i = 0; i < 6; i++) {
    box = await send<LocateResult>(tabId, { cmd: "locateReplyBox", commentId: scope }).catch(() => null);
    if (box?.ok && box.x != null) break;
    await sleep(rng.float(300, 700));
  }
  if (!box?.ok || box.x == null) {
    // No composer. Re-check the locked/archived banner (it can render a beat
    // after the read dwell): a blocked thread is permanent (drop), everything
    // else stays a transient failure the tick defers + retries.
    const l2 = await send<{ blocked?: boolean; reason?: string }>(tabId, { cmd: "checkCommentsLocked" }).catch(() => null);
    if (l2?.blocked) return { kind: "removed", reason: l2.reason ?? "comments-locked", durable: true };
    return { kind: "failed", detail: box?.skipReason ?? "reply-box-not-found" };
  }
  await cdp.moveAndClick(tabId, rectFrom(box), rng, sleep); // focus the box
  throwIfAborted(runAbort.signal); // STOP before we type anything
  const typed = sanitizeReplyBody(item.body);
  // Remember what we put in the box. The unscoped clear (navigateTab hops, which
  // carry no item) uses this to tell OUR leftover reply from a comment the
  // operator is half-way through writing — new Reddit persists comment drafts,
  // so wiping the wrong one destroys their text for good.
  lastTypedBody = typed;
  await cdp.typeText(tabId, typed, rng, sleep); // VERBATIM, sanitized
  await sleep(rng.float(500, 2200)); // reread own reply before submitting (widened upper tail)

  // Poll for a CLICKABLE submit instead of a single-shot locate (unifies #451's
  // submit-readiness poll (ports #420) with #444's deadline poll + failure
  // telemetry): the composer enables the button a beat after typing (framework
  // editor state sync + layout), and the same thread can land on one attempt and
  // miss on the next without this tolerance. locateReplySubmit skips a
  // disabled/aria-disabled button (typed text hasn't registered) and a zero-rect
  // one (a click would land at the viewport corner), so the poll simply rides
  // those states out; the extra time is only ever spent on an attempt that would
  // otherwise fail — a success clicks on the first pass. No keyboard-chord
  // fallback on purpose: a chord after a late-landing click risks a double-post;
  // the bounded confirmation probes below observe the result without another click.
  const deadline = Date.now() + Math.round(rng.float(6000, 12000));
  let submit: LocateResult | null = null;
  let lastSkip: string | undefined;
  for (;;) {
    const r = await send<LocateResult>(tabId, { cmd: "locateReplySubmit", commentId: scope }).catch(() => null);
    if (r?.ok && r.x != null) { submit = r; break; }
    if (r?.skipReason) lastSkip = r.skipReason;
    if (Date.now() >= deadline) break;
    await sleep(rng.float(350, 650));
  }
  if (!submit) {
    // Failure-path telemetry only (never costs the happy path): the composer read
    // names the state (present/empty), diagnoseReplySubmit re-walks the locator
    // predicates into buckets, and detail.ts folds both — plus the locator's last
    // skipReason and the build stamp — into reply-failed:submit-not-found(...).
    const st = await send<{ observed?: { present?: boolean; empty?: boolean } }>(
      tabId, { cmd: "readReplyBox", commentId: scope },
    ).catch(() => null);
    const dg = await send<{ observed?: SubmitDiag }>(
      tabId, { cmd: "diagnoseReplySubmit", commentId: scope },
    ).catch(() => null);
    return { kind: "failed", detail: submitNotFoundDetail(st?.observed, lastSkip, dg?.observed) };
  }
  throwIfAborted(runAbort.signal);
  const captured = readCapturedReply(item);
  if (!captured) return { kind: "failed", detail: "missing-original-capture" };
  return submitRedditReply({
    claim: () => new ActuatorApi(cfg).claimReply(captured),
    checkStopped: () => throwIfAborted(runAbort.signal),
    click: () => cdp.moveAndClick(tabId, rectFrom(submit!), rng, sleep),
    verify: () => send(tabId, { cmd: "verifyReplyPosted", commentId: scope }),
    challenge: () => send(tabId, { cmd: "detectChallenge" }),
    sleep, delay: (min, max) => rng.float(min, max),
    notCleared: notClearedDetail(submit.observed as SubmitObserved | undefined),
  });

}

// ── Lights-out autonomy ────────────────────────────────────────────────────
// A persistent alarm (survives service-worker suspend) checks a few times an
// hour whether to auto-start the daily run, no manual Run click. Once started,
// the content-script tick loop drives it as usual; a persisted day key enforces
// one auto-start per day. Requires a logged-in reddit.com tab open (startRun
// attaches to it); with none open the run pauses until a tab appears.
const AUTO_START_DAY_KEY = "actuator.lastAutoStartDay";
// Day key of the most recent challenge halt (stamped in endRun). Drives the
// post-challenge cooldown/backoff + health safety gate below. Distinct from
// AUTO_START_DAY_KEY so a suppressed tick never masks the once-per-day guard.
const CHALLENGE_DAY_KEY = "actuator.lastChallengeDay";
// Day key of the last manual STOP. A STOP must silence BOTH autonomy paths for
// the rest of the day (the daily auto-start already stamps AUTO_START_DAY_KEY;
// auto-drain has no daily guard, so it reads this instead).
const STOP_DAY_KEY = "actuator.lastManualStopDay";
// ms stamp of the last auto-drain start + the re-arm cooldown between starts.
// The cooldown bounds the pathological loop of a drain that keeps dying with
// items still queued (no reddit tab, reply-fail give-ups) — without it the 5-min
// alarm would relaunch a doomed drain forever.
const AUTO_DRAIN_MS_KEY = "actuator.lastAutoDrainMs";
const AUTO_DRAIN_REARM_MIN = 30;
// No-progress threshold that flags a running run as a stall CANDIDATE (while
// drafts are loaded and comment slots are overdue). Only a candidate: recovery
// additionally requires the stall to persist across two consecutive autonomy
// ticks with no progress between them (confirmStall) — that is what actually
// rules out a healthy run's large-but-legitimate gaps (scheduled-mode spacing
// under maxWritesPerHour, or a post mid-flight while the slot still reads
// overdue). This floor just avoids probing on short pacing gaps. Reddit's
// drain-cooldown band reaches ~19 min, so the floor is 30 (not 20) to keep the
// probe off normal drains entirely. Config override: cfg.stallRecoverMinutes.
const STALL_RECOVER_MIN = 30;
// Two-tick confirmation probe: the last stall observation (session + progress
// marker). Recovery only acts when a run looks stalled on two consecutive
// autonomy ticks with no progress between them (see confirmStall).
const STALL_PROBE_KEY = "actuator.stallProbe";
// Last build stamp a self-reload was attempted for (one attempt per stamp).
const RELOAD_STAMP_KEY = "actuator.lastReloadStamp";
async function ensureAutonomyAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(AUTONOMY_ALARM))) {
    await chrome.alarms.create(AUTONOMY_ALARM, { periodInMinutes: 5 });
  }
}
async function checkAutonomy(): Promise<void> {
  if (await remoteStopped()) return; // remote STOP is authoritative — hands stay down
  const cfg = await getConfig();
  if (!cfg?.autonomous) return;
  const s = await loadState();
  const now = new Date();
  const store = await chrome.storage.local.get(AUTO_START_DAY_KEY);
  // Read the challenge-day stamp fail-closed: if storage throws, skip this tick
  // rather than risk auto-starting a freshly-challenged account.
  let lastChallengeDay: string | null;
  try {
    const chStore = await chrome.storage.local.get(CHALLENGE_DAY_KEY);
    lastChallengeDay = (chStore[CHALLENGE_DAY_KEY] as string | undefined) ?? null;
  } catch {
    console.warn("[autonomy] challenge-day read failed; skipping auto-start");
    return;
  }
  const decide = shouldAutoStart({
    autonomous: true,
    runActive: s?.status === "running",
    localHour: now.getHours(),
    startHour: cfg.autoStartHour ?? 9,
    endHour: cfg.autoEndHour ?? 21,
    todayKey: localDayKey(now),
    lastAutoStartDay: (store[AUTO_START_DAY_KEY] as string | undefined) ?? null,
    // Post-challenge backoff (default OFF via undefined/0).
    lastChallengeDay,
    challengeBackoffDays: cfg.autoChallengeBackoffDays ?? 0,
  });
  // Pending-arm gate (fail-closed): a manual start that ARMED the reply switch
  // but died before persisting RunState leaves the durable marker behind (see
  // setPendingArm in startRun/startDrain). While it stands, the switch may be ON
  // without any run accounting for it — so EITHER lights-out path below (the
  // daily auto-start OR maybeAutoDrain) would post replies under a consent flag
  // the operator never chose to leave standing. This gate runs BEFORE the
  // decide/auto-drain branch so it fail-closes BOTH: #452's auto-drain must not
  // slip out under a leaked/in-flight #463 arm any more than the auto-start may.
  // A FRESH marker ("wait") is a manual start still in flight between its arm
  // and its saveState: never disarm under it, just skip this tick. A STALE
  // marker ("disarm") is a leaked arm: retry the disarm (serialized, and
  // re-classified inside the lock so a manual start that lands meanwhile is
  // never raced back OFF) and keep refusing to auto-start/drain until it
  // succeeds. Either way do NOT stamp AUTO_START_DAY_KEY → re-evaluates next
  // tick. In the normal case (no marker) classifyPendingArm returns "none" and
  // this is a no-op passthrough, so autonomy's happy path is unchanged.
  const armAction = classifyPendingArm(await getPendingArm(), Date.now());
  if (armAction !== "none") {
    if (armAction === "disarm") {
      await withSendSwitch(async () => {
        const cur = await getPendingArm();
        if (!cur || classifyPendingArm(cur, Date.now()) !== "disarm") return;
        try {
          await new ActuatorApi(cfg).enableSend(cfg.instanceId, false);
          await clearPendingArm(cur.epoch);
          console.warn("[autonomy] disarmed a leaked reply-switch arm from a failed manual start");
        } catch {
          /* still unconfirmed → the marker stays and autonomy stays blocked */
        }
      });
    }
    console.warn("[autonomy] autonomy suppressed (auto-start + auto-drain): unresolved reply-switch arm", { armAction });
    return;
  }

  if (!decide) {
    // A run may be live but WEDGED (running, not posting). Recover it first —
    // shouldAutoDrain's runActive gate can't, so a wedged run would otherwise pin
    // the actor with approvals piling up. If nothing needed recovery, fall through
    // to lights-out inbox clearing (approvals waiting while nothing runs).
    const recovered = await maybeRecoverStalledRun(cfg, s ?? null, now, lastChallengeDay);
    if (!recovered) await maybeAutoDrain(cfg, s ?? null, now, lastChallengeDay);
    return;
  }

  // Secondary safety gate: post-challenge cooldown (default 3d) + server health.
  // Any error/non-2xx/timeout from health() collapses to null → treated as
  // not-ok when the gate is on (default) → skip. Manual operator Run (the
  // 'startRun' message path) never runs this gate.
  const api = new ActuatorApi(cfg);
  const health = await api.health().catch(() => null); // fetch fail → null → fail-closed
  const safe = passesAutoStartSafety({
    healthGate: cfg.healthGate ?? true,
    healthStatus: health?.status ?? null,
    challengeCooldownDays: cfg.challengeCooldownDays ?? 3,
    todayKey: localDayKey(now),
    lastChallengeDay,
  });
  if (!safe) {
    console.warn("[autonomy] auto-start suppressed by safety gate", { health: health?.status ?? "unknown" });
    return; // do NOT stamp AUTO_START_DAY_KEY → re-evaluates next tick when health recovers
  }

  // Stamp the day BEFORE starting so a mid-start crash can't double-fire today.
  await chrome.storage.local.set({ [AUTO_START_DAY_KEY]: localDayKey(now) });
  await startRun({
    windowHours: cfg.autoWindowHours ?? 8,
    targetComments: cfg.autoTargetComments ?? REDDIT_DEFAULTS.repliesPerDay,
    targetLikes: 0, // no scheduled vote SLOTS (upvotes are idle-only); startRun re-zeroes this regardless.
  }).catch((e) => console.warn("[autonomy] auto-start failed:", e instanceof Error ? e.message : e));
}
// Lights-out inbox clearing. When the operator opted in (Options → auto-drain),

// Chrome Bridge extension — service worker. Drives the HTTP short-poll transport:
// poll the bridge for queued ChromeOps, execute each in the operator's Chrome, and
// report the result. An MV3 service worker is evicted after ~30s idle, so — like
// the actuators — the loop is woken from BOTH a chrome.alarms alarm AND a
// content-script setInterval ({cmd:"poll-tick"}); either triggers pump().
import { executeOp } from "../ops.js";
import { pollOps, reportResult, hello, getBuild, heartbeat } from "../net.js";
import { chromeVersion } from "../ops.js";

const POLL_ALARM = "bridge-poll"; // wakes pump() ~every 30s (backstop for the content tick)
const MAINT_ALARM = "bridge-maint"; // self-reload + heartbeat, ~every 5 min
const SOURCE = "chrome-bridge-ext";
const RELOAD_STAMP_KEY = "bridge.lastReloadStamp";

// Coalesce the flood of poll-ticks: the content script runs on <all_urls>, so with
// many tabs open dozens of ticks/sec would arrive. pump() no-ops unless this much
// time has passed since the last run — keeping the real poll rate ~1/sec no matter
// how many tabs drive it, while still surfacing an op within a poll interval.
const MIN_PUMP_GAP_MS = 1_000;

function embeddedStamp(): string | null {
  return typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__ : null;
}

// --- the poll loop -------------------------------------------------------------

let pumping = false;
let lastPumpAt = 0;

async function pump(): Promise<void> {
  if (pumping) return; // a previous pump (or a long op) is still running
  const now = Date.now();
  if (now - lastPumpAt < MIN_PUMP_GAP_MS) return; // coalesce many-tab tick storms
  pumping = true;
  lastPumpAt = now;
  try {
    const res = await pollOps();
    if (!res || res.requests.length === 0) return;
    // Sequential on purpose: one debugger slot, and serial execution avoids two ops
    // racing the same tab. A slow op (waitForLoad ≤120s) delays the batch, which is
    // fine for agent-driven debugging.
    for (const req of res.requests) {
      const result = await executeOp(req.op);
      await reportResult(req.id, result);
    }
  } finally {
    pumping = false;
  }
}

// --- hello / heartbeat ---------------------------------------------------------

async function sayHello(): Promise<void> {
  const m = chrome.runtime.getManifest();
  const info = {
    extId: chrome.runtime.id,
    extVersion: m.version,
    chromeVersion: chromeVersion(),
    buildStamp: embeddedStamp() ?? undefined,
  };
  await hello(info);
}

async function sendHeartbeat(): Promise<void> {
  await heartbeat({
    source: SOURCE,
    at: new Date().toISOString(),
    state: pumping ? "running" : "idle",
    detail: { build_stamp: embeddedStamp() ?? undefined },
  });
}

// --- self-reload ---------------------------------------------------------------

// Deploys are merge-driven: `noelle sync` rebuilds the extension into
// .output/chrome-mv3 (→ dist-unpacked), but an unpacked extension keeps running the
// stale bundle until something reloads it. The bridge serves the on-disk stamp at
// GET /ext/build; when it is strictly newer than the stamp compiled into THIS
// bundle, chrome.runtime.reload() re-reads the unpacked dir (== clicking Reload on
// chrome://extensions). Mirrors the LinkedIn actuator's checkSelfReload.
//
// Storm guards: (1) only reload for a strictly newer stamp (ISO strings sort
// lexically), never an older/rolled-back one; (2) require seeing the same newer
// stamp on TWO consecutive checks ("stable once") before acting; (3) persist the
// attempted stamp so a stale disk copy can't reload-loop every cycle.
let seenServedStamp: string | null = null;

async function checkSelfReload(): Promise<void> {
  const embedded = embeddedStamp();
  if (!embedded) return;
  const served = (await getBuild())?.stamp ?? null;
  if (!served || served <= embedded) {
    seenServedStamp = null; // bridge down / already current / older → disarm
    return;
  }
  const store = await chrome.storage.local.get(RELOAD_STAMP_KEY);
  if (served === (store[RELOAD_STAMP_KEY] as string | undefined)) return; // one attempt per stamp
  if (seenServedStamp !== served) {
    seenServedStamp = served; // first sight — arm, wait for it to hold stable
    return;
  }
  await chrome.storage.local.set({ [RELOAD_STAMP_KEY]: served });
  console.info("[chrome-bridge] newer build on disk; reloading extension", { from: embedded, to: served });
  chrome.runtime.reload();
}

// --- wiring --------------------------------------------------------------------

async function ensureAlarms(): Promise<void> {
  if (!(await chrome.alarms.get(POLL_ALARM))) await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  if (!(await chrome.alarms.get(MAINT_ALARM))) await chrome.alarms.create(MAINT_ALARM, { periodInMinutes: 5 });
}

async function boot(): Promise<void> {
  await ensureAlarms();
  await sayHello();
  await sendHeartbeat();
  await pump();
}

chrome.runtime.onStartup.addListener(() => void boot());
chrome.runtime.onInstalled.addListener(() => void boot());

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === POLL_ALARM) void pump();
  else if (a.name === MAINT_ALARM) {
    void checkSelfReload();
    void sendHeartbeat();
  }
});

// The content-script tick — the reliable wake, since MV3 SW timers are not.
chrome.runtime.onMessage.addListener((msg: { cmd?: string }) => {
  if (msg?.cmd === "poll-tick") void pump();
  // No response needed; return nothing so the channel closes synchronously.
});

// Run once on every SW cold start too (onStartup only fires on browser launch, and
// after an eviction the persisted alarms wake us but neither lifecycle event fires).
void boot();

import { NOTIFICATIONS_ACTOR_ENABLED } from "../lib/notifications-feature.js";
import { createActorPanel, watchActorLeadCapacity, watchActorReplyCap, DEFAULT_DISCOVERY_SCHEDULE, DISCOVERY_SCHEDULE_KEY, parseDiscoverySchedule } from "@noelle/actuator-cdp";
// In-page control surface for the actuator.
//
// It lives inside a CLOSED shadow root under a host element with a per-load
// RANDOM id and no identifying light-DOM text or child ids. A page-side DOM walk
// (LinkedIn's BrowserGate/Spectroscopy scans every text node + attribute) sees
// only an anonymous <div> with a random id and no children, not a stable
// "noelle-actuator-panel" / "Noelle Actuator" / na-* signature. A closed shadow
// root is not reachable via host.shadowRoot (returns null) and its contents are
// not matched by document-level querySelector, so the controls, ids, and label
// are invisible to the page. The setInterval tick loop that keeps the MV3 flow
// alive is preserved unchanged.

let hostRef: HTMLElement | null = null;

function randomHostId(): string {
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  // lead with a letter so it's a valid id; keep it opaque and non-static.
  return `x${rand.slice(0, 12)}`;
}

export function mountPanel(): void {
  // Guard on live DOM presence (not a stable selector), so it re-mounts if the
  // host is ever torn out, matching the previous behaviour without a fixed id.
  if (hostRef && hostRef.isConnected) return;

  const host = document.createElement("div");
  host.id = randomHostId();
  // Jitter the position per load so the host carries no STABLE light-DOM
  // signature: a fixed cssString (same top/right every load) is matchable by a
  // page DOM walk even when the id is random. Randomized offsets remove the last
  // static attribute value. z-index stays maxed so the panel is always on top.
  const top = 56 + Math.floor(Math.random() * 40); // ~56–96px
  const right = 8 + Math.floor(Math.random() * 24); // ~8–32px
  host.style.cssText = `position:fixed;top:${top}px;right:${right}px;z-index:2147483647`;
  const root = host.attachShadow({ mode: "closed" });
  const view = createActorPanel(root, {
    platform: "X",
    quietDescription: "Pause replies and likes",
    notificationsEnabled: NOTIFICATIONS_ACTOR_ENABLED,
  });
  watchActorLeadCapacity(view, () => chrome.runtime.sendMessage({ cmd: "getDiscoveryCapacity" }));
  watchActorReplyCap(view, {
    read: () => chrome.runtime.sendMessage({ cmd: "getReplyCap" }),
    write: (cap, minimum) => chrome.runtime.sendMessage({ cmd: "setReplyCap", cap,
      ...(minimum === undefined ? {} : { minimum }) }),
  });
  document.body.appendChild(host);
  hostRef = host;

  const q = view.query;
  const log = (m: string) => {
    if (/FAILED|Could not|Choose two|^→/i.test(m)) view.reportError(m);
  };
  const quietEnabled = q<HTMLInputElement>("#na-discovery-quiet");
  const quietStart = q<HTMLInputElement>("#na-discovery-start");
  const quietEnd = q<HTMLInputElement>("#na-discovery-end");
  const scheduleInputs = [quietEnabled, quietStart, quietEnd];
  for (const input of scheduleInputs) input.disabled = true;
  let scheduleTouched = false;
  let scheduleValid = true;
  let scheduleLoadFailed = false;
  let editVersion = 0;
  let pendingSave: Promise<boolean> = Promise.resolve(true);
  let savedSchedule = DEFAULT_DISCOVERY_SCHEDULE;
  const scheduleReady = chrome.storage.local.get(DISCOVERY_SCHEDULE_KEY).then((stored) => {
    if (scheduleTouched) return; // a fast user edit wins over the initial read
    savedSchedule = parseDiscoverySchedule(stored[DISCOVERY_SCHEDULE_KEY]);
    quietEnabled.checked = savedSchedule.enabled;
    quietStart.value = savedSchedule.start;
    quietEnd.value = savedSchedule.end;
    view.setHours(savedSchedule.enabled ? `${savedSchedule.start}–${savedSchedule.end}` : "24/7");
  }).catch((e) => {
    scheduleLoadFailed = true;
    log(`Could not load discovery hours: ${e instanceof Error ? e.message : String(e)}`);
  })
    .finally(() => {
      for (const input of scheduleInputs) input.disabled = false;
      q<HTMLButtonElement>("#na-discover").disabled = false;
    });
  const saveDiscoverySchedule = () => {
    scheduleTouched = true;
    const version = ++editVersion;
    const candidate = { enabled: quietEnabled.checked, start: quietStart.value, end: quietEnd.value };
    const schedule = parseDiscoverySchedule(candidate);
    if (schedule.enabled !== candidate.enabled || schedule.start !== candidate.start || schedule.end !== candidate.end) {
      scheduleValid = false;
      quietEnabled.checked = savedSchedule.enabled;
      log("Choose two different valid times before saving the quiet window.");
      return;
    }
    scheduleValid = true;
    // Storage writes can finish out of order if two time inputs change quickly.
    // Chain them, and make Discover wait for the latest successful write.
    pendingSave = pendingSave.then(async () => {
      try {
        await chrome.storage.local.set({ [DISCOVERY_SCHEDULE_KEY]: schedule });
        savedSchedule = schedule;
        scheduleLoadFailed = false;
        view.setHours(schedule.enabled ? `${schedule.start}–${schedule.end}` : "24/7");
        view.clearError();
        log(schedule.enabled ? `Discovery writes pause ${schedule.start}–${schedule.end} local time; browsing continues.` : "Discovery runs 24/7.");
        return true;
      } catch (e) {
        if (version === editVersion) quietEnabled.checked = savedSchedule.enabled;
        log(`Could not save discovery hours: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    });
  };
  for (const input of scheduleInputs) input.addEventListener("change", saveDiscoverySchedule);
  // Every start goes through here, and the reason is a real bug we shipped: the
  // old handlers began with `await chrome.runtime.sendMessage(...)` and only
  // logged inside the `if (res?.ok)` branch. When that call REJECTS — which is
  // exactly what happens when the tab is running a content script whose
  // extension context was invalidated by a reload/update, or when the MV3
  // service worker fails to wake — the async handler threw, nothing was
  // written to the log, and the button looked completely dead. "The button
  // does nothing" was literally true and gave us nothing to debug.
  //
  // So: log BEFORE awaiting (the click is always acknowledged), and catch the
  // rejection with an actionable hint instead of losing it.
  const start = async (cmd: string, label: string, lines: string[]) => {
    log(`${label} — starting…`);
    let res: { ok?: boolean; error?: string } | undefined;
    try {
      res = (await chrome.runtime.sendMessage({ cmd })) as { ok?: boolean; error?: string } | undefined;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      log(`${label} FAILED: ${why}`);
      if (/context invalidated|Receiving end does not exist|message port closed|Could not establish connection/i.test(why)) {
        log("→ this TAB is running an old copy of the extension. Reload the page (Cmd-R) and click again.");
      }
      return;
    }
    if (res?.ok) {
      view.clearError();
      for (const line of lines) log(line);
      return;
    }
    const why = res?.error ?? "no response from the background worker";
    log(`${label} FAILED: ${why}`);

    // "unknown command" means the background SERVICE WORKER is running older
    // code than this panel: the panel sent a command the worker's dispatcher
    // has never heard of. It is not a config problem and no amount of clicking
    // fixes it — an unpacked extension does NOT pick up a rebuilt bundle on its
    // own, so the worker stays stale until something reloads the extension.
    //
    // Observed in the wild as a loop the operator could not escape:
    //   2:09:51 AM  AUTO — starting…
    //   2:09:51 AM  AUTO FAILED: unknown command
    //   2:09:56 AM  AUTO — starting…
    //   2:09:56 AM  AUTO FAILED: unknown command
    //
    // So heal it here. chrome.runtime.reload() restarts the extension with the
    // built bundle on disk, which is the exact manual step
    // (chrome://extensions -> reload) the operator would otherwise have to find
    // — and cannot do at all from a phone. The tab's content script is torn
    // down by the reload, hence the "reload this page" note before it fires.
    if (/unknown command/i.test(why)) {
      log("→ the background worker is running OLDER code than this panel.");
      log("→ reloading the extension now; reload this page (Cmd-R), then click again.");
      // Give the two lines a beat to paint before the context goes away.
      setTimeout(() => {
        try {
          chrome.runtime.reload();
        } catch {
          log("→ could not self-reload; open chrome://extensions and press Reload.");
        }
      }, 1200);
      return;
    }

    if (/not configured/i.test(why)) log("→ set API URL + token + instance id in Options");
    else if (/fetch|network|load failed/i.test(why)) log("→ can't reach the API — check the API base URL in Options");
  };

  q("#na-stop").addEventListener("click", () => {
    // STOP gets the same treatment, and it is the WORST button to fail
    // silently: it is the one you press when you want the actuator to stop, and
    // a dead click would leave you believing a live run had been halted when it
    // had not. Any rejection is surfaced with the reload hint.
    void (async () => {
      log("STOP — stopping…");
      try {
        const res = await chrome.runtime.sendMessage({ cmd: "stopRun" });
        if (!res?.ok) {
          log(`STOP FAILED: ${res?.error ?? "no response from the background worker"}`);
          return;
        }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        log(`STOP FAILED: ${why}`);
        if (/context invalidated|Receiving end does not exist|message port closed|Could not establish connection/i.test(why)) {
          log("→ this TAB is running an old copy of the extension. Reload the page (Cmd-R) — the run may still be LIVE.");

import { NOTIFICATIONS_ACTOR_ENABLED } from "../lib/notifications-feature.js";
import { createActorPanel, watchActorLeadCapacity, watchActorReplyCap, DISCOVERY_SCHEDULE_KEY, parseDiscoverySchedule } from "@noelle/actuator-cdp";
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
  host.style.cssText = "position:fixed;top:72px;right:16px;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const view = createActorPanel(root, {
    platform: "LinkedIn",
    quietDescription: "Pause comments and DMs",
    notificationsEnabled: NOTIFICATIONS_ACTOR_ENABLED,
  });
  watchActorLeadCapacity(view, () => chrome.runtime.sendMessage({ cmd: "getDiscoveryCapacity" }));
  watchActorReplyCap(view, {
    read: () => chrome.runtime.sendMessage({ cmd: "getReplyCap" }),
    write: (cap) => chrome.runtime.sendMessage({ cmd: "setReplyCap", cap }),
  });
  document.body.appendChild(host);
  hostRef = host;

  const q = view.query;
  const log = (m: string) => {
    if (/FAILED|Could not|Choose two|^→/i.test(m)) view.reportError(m);
  };
  const showDiscovery = (
    enabled: boolean,
    running: boolean,
  ) => {
    view.render({ status: running ? "running" : "idle" }, enabled);
  };
  const quiet = q<HTMLInputElement>("#na-discovery-quiet");
  const quietStart = q<HTMLInputElement>("#na-discovery-start");
  const quietEnd = q<HTMLInputElement>("#na-discovery-end");
  const scheduleStatus = q("#na-discovery-schedule-status");
  const showSchedule = () => {
    scheduleStatus.textContent = quiet.checked
      ? `Quiet ${quietStart.value}–${quietEnd.value} (local time)`
      : "24/7 (local time)";
    view.setHours(quiet.checked ? `${quietStart.value}–${quietEnd.value}` : "24/7");
  };
  const loadSchedule = chrome.storage.local.get(DISCOVERY_SCHEDULE_KEY).then((stored) => {
    const schedule = parseDiscoverySchedule(stored[DISCOVERY_SCHEDULE_KEY]);
    quiet.checked = schedule.enabled;
    quietStart.value = schedule.start;
    quietEnd.value = schedule.end;
    showSchedule();
    q<HTMLButtonElement>("#na-discover").disabled = false;
    quiet.disabled = false;
    quietStart.disabled = false;
    quietEnd.disabled = false;
    return true;
  }).catch((error: unknown) => {
    scheduleStatus.textContent = "Schedule unavailable — reload this tab";
    log(`Could not load discovery schedule: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  });
  let scheduleSave: Promise<void> = Promise.resolve();
  const saveSchedule = async (): Promise<boolean> => {
    if (!(await loadSchedule)) return false;
    const next = { enabled: quiet.checked, start: quietStart.value, end: quietEnd.value };
    const parsed = parseDiscoverySchedule(next);
    if (parsed.start !== next.start || parsed.end !== next.end) {
      scheduleStatus.textContent = "Choose two different valid times";
      return false;
    }
    try {
      scheduleSave = scheduleSave.catch(() => {}).then(() => chrome.storage.local.set({ [DISCOVERY_SCHEDULE_KEY]: parsed }));
      await scheduleSave;
      showSchedule();
      view.clearError();
      return true;
    } catch (error) {
      log(`Could not save discovery schedule: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  for (const input of [quiet, quietStart, quietEnd]) {
    input.addEventListener("change", () => { void saveSchedule(); });
  }
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
  const start = async (cmd: string, label: string, lines: string[], onSuccess?: () => void) => {
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
      onSuccess?.();
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
        }
        return;
      }
      showDiscovery(false, false);
      view.clearError();
      log("STOPPED");
    })();
  });
  q("#na-discover").addEventListener("click", () => {
    void (async () => {
      if (!(await saveSchedule())) return;
      await start("startBrowserDiscovery", "DISCOVER + REPLY", [
        "reading posts at the actor's normal pace and sending suitable replies after review",
        "press STOP to end",
      ], () => showDiscovery(true, true));
    })();
  });
  // Manual Auto: drain everything the operator approved, right now, at the hour
  // they chose — no overnight hold.
  q("#na-drain").addEventListener("click", () => {
    void start("startDrain", "MANUAL AUTO", [
      "draining ALL approved replies, ~1-2 min apart, browsing + liking (4-8) between each",
      "set-and-forget: survives reloads/restarts, resumes on its own — no re-click; press STOP to end",
      "(no overnight pause — for that, use Auto instead)",
    ]);
  });
  q("#na-fullauto").addEventListener("click", () => {
    void start("startFullAuto", "AUTO", [
      "draining approvals + watching for new ones (safe to leave running)",
      "pauses comments/DMs overnight 1am–9am; likes + browsing stay on. Press STOP to end",
    ]);
  });
  // Auto notifications: the conversation lane. It IS an unattended drain (so
  // whatever Lyra drafts from the sweep gets posted by this same run), plus a
  // periodic sweep of the notifications page that enqueues the people who
  // replied to us. One click runs the whole loop.
  if (NOTIFICATIONS_ACTOR_ENABLED) q("#na-notifs").addEventListener("click", () => {
    void start("startNotifications", "AUTO NOTIFICATIONS", [
      "checking notifications every ~10-20 min for people who replied to you",
      "each one goes to Lyra to draft, then this same run posts it. Press STOP to end",
      "pauses comments overnight 1am–9am; approvals already queued drain as usual",
    ]);
  });

  setInterval(async () => {
    // Drive the loop from here: the content script stays alive as long as the
    // tab is open, unlike the MV3 service worker whose alarms/timers are
    // unreliable. tick() is a no-op unless an action is actually due, so the
    // human pacing (the schedule) is preserved.
    await chrome.runtime.sendMessage({ cmd: "tick" }).catch(() => null);
    const r = await chrome.runtime.sendMessage({ cmd: "getState" }).catch(() => null);
    const s = r?.state;
    if (r?.ok && typeof r.browserDiscoveryActive === "boolean") {
      const observationError = r.browserDiscoveryStatus?.result === "failed"
        ? `Observation failed: ${r.browserDiscoveryStatus.error ?? "unknown error"}` : "";
      const identity = r.browserDiscoveryIdentityStatus;
      const identityAt = Date.parse(identity?.at ?? "");
      const identityAge = Date.now() - identityAt;
      const observationAt = Date.parse(r.browserDiscoveryStatus?.at ?? "");
      const identityError = r.browserDiscoveryActive && identity?.result === "unresolved" &&
        identityAge >= 0 && identityAge < 10 * 60_000 &&
        (!Number.isFinite(observationAt) || identityAt >= observationAt)
        ? `Post link unavailable: ${identity.reason ?? "unknown reason"}` : "";
      view.render(s ? { ...s, lastEvent: observationError || identityError || s.lastEvent } : null, r.browserDiscoveryActive);
    }
  }, 4_000);
}

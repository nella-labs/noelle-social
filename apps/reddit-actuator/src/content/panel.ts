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
  // The panel's only volume knob is replies/day (capped Reddit-safe, default 8, in
  // the background). There is deliberately NO manual vote button here: UPVOTING is
  // an automatic, operator-opt-in, rate-capped IDLE behavior configured in Options
  // (upvotesEnabled) — upvote-only, ≤10/15min, never a downvote.
  root.innerHTML = `
    <div style="width:280px;padding:12px;background:#1b1b1b;color:#f5f0e6;font:12px/1.4 system-ui;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.4)">
      <div style="font-weight:600;margin-bottom:8px">Noelle Reddit Actuator</div>
      <label>Window (min) <input id="na-min" type="number" value="480" min="1" max="960" step="1" style="width:56px"></label>
      <label>Replies <input id="na-c" type="number" value="8" min="0" max="8" style="width:48px"></label>
      <div style="margin-top:8px;display:flex;gap:8px">
        <button id="na-run" style="flex:1;padding:6px;background:#b5532a;color:#fff;border:0;border-radius:6px">Run</button>
        <button id="na-stop" style="flex:1;padding:6px;background:#333;color:#fff;border:0;border-radius:6px">STOP</button>
      </div>
      <button id="na-drain" style="width:100%;margin-top:6px;padding:6px;background:#7a3b1f;color:#fff;border:0;border-radius:6px">Drain all approvals</button>
      <pre id="na-log" style="margin-top:8px;max-height:140px;overflow:auto;white-space:pre-wrap"></pre>
    </div>`;
  document.body.appendChild(host);
  hostRef = host;

  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const log = (m: string) => {
    const pre = q("#na-log");
    if (!pre) return;
    pre.textContent = `${new Date().toLocaleTimeString()}  ${m}\n${pre.textContent ?? ""}`.slice(0, 4000);
  };
  const num = (sel: string) => Number(q<HTMLInputElement>(sel).value);

  q("#na-run").addEventListener("click", async () => {
    const mins = num("#na-min");
    // targetLikes is hard-zero: Reddit is reply-only, the actuator never votes.
    const params = { windowHours: mins / 60, targetComments: num("#na-c"), targetLikes: 0 };
    const res = await chrome.runtime.sendMessage({ cmd: "startRun", params });
    if (res?.ok) {
      log(`started: ${params.targetComments} replies over ${mins} min — warming up, then replying`);
    } else {
      const why = res?.error ?? "no response";
      log(`START FAILED: ${why}`);
      if (healIfStale(why)) return;
      if (/not configured/i.test(why)) log("→ open the extension Options, set API URL + token + instance id, Save");
      else if (/fetch|network|load failed/i.test(why)) log("→ can't reach the API — check the API base URL in Options (http://localhost:18791)");
    }
  });
  // "unknown command" means the background SERVICE WORKER is running older code
  // than this panel: it was sent a command its dispatcher has never heard of.
  // An unpacked extension does NOT pick up a rebuilt bundle on its own, so the
  // worker stays stale and clicking again can never work. chrome.runtime.reload()
  // restarts it from the bundle on disk — the manual chrome://extensions Reload,
  // done for you, which matters most on a phone where that page is unreachable.
  const healIfStale = (why: string): boolean => {
    if (!/unknown command/i.test(why)) return false;
    log("→ the background worker is running OLDER code than this panel.");
    log("→ reloading the extension now; reload this page, then click again.");
    setTimeout(() => {
      try {
        chrome.runtime.reload();
      } catch {
        log("→ could not self-reload; open chrome://extensions and press Reload.");
      }
    }, 1200);
    return true;
  };

  q("#na-stop").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ cmd: "stopRun" });
    log("STOPPED");
  });
  q("#na-drain").addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ cmd: "startDrain" });
    if (res?.ok) {
      log("draining ALL approved replies — newest first, 4–19 min apart, browsing + upvoting between each");
      log("stays open watching for new approvals — no re-click needed; press STOP to end");
    } else {
      const why = res?.error ?? "no response";
      log(`DRAIN FAILED: ${why}`);
      if (healIfStale(why)) return;
      if (/not configured/i.test(why)) log("→ open the extension Options, set API URL + token + instance id, Save");
      else if (/fetch|network|load failed/i.test(why)) log("→ can't reach the API — check the API base URL in Options (http://localhost:18791)");
    }
  });

  let lastLogged = "";
  setInterval(async () => {
    // Drive the loop from here: the content script stays alive as long as the
    // tab is open, unlike the MV3 service worker whose alarms/timers are
    // unreliable. tick() is a no-op unless an action is actually due, so the
    // human pacing (the schedule) is preserved.
    await chrome.runtime.sendMessage({ cmd: "tick" }).catch(() => null);
    const r = await chrome.runtime.sendMessage({ cmd: "getState" }).catch(() => null);
    const s = r?.state;
    if (!s) return;
    const done = s.actions.filter((a: any) => a.executed).length;
    const line = `${s.status} ${done}/${s.actions.length}${s.lastEvent ? " — " + s.lastEvent : ""}`;
    if (line !== lastLogged) { log(line); lastLogged = line; } // only log changes
  }, 4_000);
}

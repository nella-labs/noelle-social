/** Shared Options surface. Field IDs and defaults are the existing storage contract. */
export function renderActorOptionsPage(root: HTMLElement, platform: "LinkedIn" | "X"): void {
  const isX = platform === "X";
  root.innerHTML = `
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #181713; color: #f3eadf; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; }
      main { max-width: 640px; margin: 36px auto 70px; padding: 0 18px; }
      header { margin-bottom: 24px; }
      .eyebrow { color: #b5815d; font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
      h1 { margin: 2px 0 6px; font: italic 38px/1.1 Georgia, serif; letter-spacing: -.04em; }
      h2 { margin: 0 0 4px; font: 21px/1.2 Georgia, serif; }
      p { margin: 0; }
      .intro, .hint { color: #a99e90; }
      .intro { max-width: 48ch; }
      .card { margin: 14px 0; padding: 22px; border: 1px solid #40392e; border-radius: 12px; background: #24211b; box-shadow: 0 12px 32px #0002; }
      .card-head { margin-bottom: 18px; }
      .hint { margin: 4px 0 0; font-size: 12px; }
      .fields { display: grid; gap: 15px; }
      label.field { display: grid; gap: 5px; color: #d6c9b9; font-size: 12px; font-weight: 650; }
      input[type=text], input[type=password], input[type=url], input[type=number] {
        width: 100%; min-height: 37px; padding: 7px 10px; border: 1px solid #605344; border-radius: 6px;
        background: #191813; color: #f3eadf; font: 14px/1.2 ui-sans-serif, system-ui, sans-serif;
      }
      input:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid #e1a677; outline-offset: 2px; }
      .check { display: flex; align-items: flex-start; gap: 10px; color: #d6c9b9; }
      .check input { margin: 3px 0 0; accent-color: #65b99c; }
      .check span { display: grid; gap: 2px; }
      .check small { color: #a99e90; font-size: 12px; }
      .row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .row.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      details { margin: 14px 0; }
      summary { cursor: pointer; color: #e6d9c9; font-size: 16px; font-weight: 650; }
      details .fields { margin-top: 18px; }
      .actions { display: flex; align-items: center; gap: 14px; margin-top: 20px; }
      button { padding: 10px 19px; border: 0; border-radius: 7px; background: #35856f; color: white; font: inherit; font-weight: 700; cursor: pointer; }
      button:hover { background: #419a80; }
      #msg { min-height: 20px; color: #83d2af; }
      @media (max-width: 500px) { main { margin-top: 22px; } .row { grid-template-columns: 1fr; } }
    </style>
    <main>
      <header><div class="eyebrow">${platform} actor · Options</div><h1>Noelle</h1>
        <p class="intro">Connection and run defaults. Set the live daily reply cap in the actor panel.</p></header>
      <form id="f">
        <section class="card" aria-labelledby="connection-heading">
          <div class="card-head"><h2 id="connection-heading">Connection</h2><p class="hint">The actor uses this local API and instance.</p></div>
          <div class="fields">
            <label class="field">API base URL<input id="apiBaseUrl" type="url" placeholder="http://127.0.0.1:18791"></label>
            <label class="field">Bearer token<input id="token" type="password" autocomplete="off"></label>
            <label class="field">${platform} instance ID<input id="instanceId" type="text" autocomplete="off"></label>
          </div>
        </section>
        <section class="card" aria-labelledby="automation-heading">
          <div class="card-head"><h2 id="automation-heading">Automation</h2><p class="hint">Discovery and reply controls are in the actor panel.</p></div>
          <div class="fields">
            <label class="check"><input id="autonomous" type="checkbox"><span>Start a daily run automatically<small>Uses the run window and targets below.</small></span></label>
            <label class="check"><input id="autoDrain" type="checkbox"><span>Drain approved replies automatically<small>Starts a drain inside the configured window when the actor is idle.</small></span></label>
          </div>
        </section>
        <details class="card"><summary>Run defaults and safety</summary>
          <div class="fields">
            <p class="hint">These limits plan scheduled runs. The live browser reply cap is set in the actor panel.</p>
            <div class="row">
              <label class="field">Likes per run<input id="capLikes" type="number" min="0" value="${isX ? 40 : 55}"></label>
              <label class="field">${isX ? "Replies" : "Comments"} per run<input id="capComments" type="number" min="0" value="${isX ? 30 : 35}"></label>
              <label class="field">${isX ? "DMs (unused)" : "DMs"} per run<input id="capDms" type="number" min="0" value="${isX ? 0 : 10}"></label>
            </div>
            <div class="row">
              <label class="field">Window start hour<input id="autoStartHour" type="number" min="0" max="23" value="9"></label>
              <label class="field">Window end hour<input id="autoEndHour" type="number" min="0" max="23" value="21"></label>
              <label class="field">Run hours<input id="autoWindowHours" type="number" min="1" max="16" value="8"></label>
            </div>
            <div class="row two">
              <label class="field">Daily ${isX ? "reply" : "comment"} target<input id="autoTargetComments" type="number" min="0" value="20"></label>
              <label class="field">Daily like target<input id="autoTargetLikes" type="number" min="0" value="40"></label>
            </div>
            <label class="field">Watchlist preference (0–1)<input id="preferWatchlistRatio" type="number" min="0" max="1" step="0.1" value="0.7"></label>
            <label class="check"><input id="deepNightTaper" type="checkbox" checked><span>Use light activity from 1–6am</span></label>
            <label class="check"><input id="ambientReadActions" type="checkbox" checked><span>Read expanded posts and comments while browsing</span></label>
            ${isX ? '<label class="check"><input id="replyAlsoLikes" type="checkbox"><span>Like a post after replying<small>Adds a separate write. Off by default.</small></span></label>' : ""}
            <div class="row two">
              <label class="field">Challenge cooldown, days<input id="challengeCooldownDays" type="number" min="0" max="14" value="3"></label>
              <label class="field">Extra challenge backoff, days<input id="autoChallengeBackoffDays" type="number" min="0" max="14" value="0"></label>
            </div>
            <label class="check"><input id="healthGate" type="checkbox" checked><span>Require healthy server for automatic start</span></label>
          </div>
        </details>
        <div class="actions"><button type="submit">Save options</button><span id="msg" role="status"></span></div>
      </form>
    </main>`;
}

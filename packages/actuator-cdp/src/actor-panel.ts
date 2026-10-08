/** Shared, browser-only control surface for the LinkedIn and X actuators. */
export interface ActorPanelState {
  status?: string;
  commentPool?: readonly unknown[];
  lastEvent?: string;
}

export interface ActorPanelView {
  query<T extends Element = HTMLElement>(selector: string): T;
  reportError(message: string): void;
  clearError(): void;
  render(state: ActorPanelState | null, discoveryActive: boolean): void;
  setLeadCapacity(capacity: { occupied: number; limit: number } | null, error?: string): void;
  setReplyCap(value: ActorReplyCap | null, error?: string, savedEdit?: boolean): void;
  setHours(summary: string): void;
}

export interface ActorReplyCap {
  sent: number; cap: number | null; remaining: number | null;
  configuredCap?: number | null; minimum?: number | null; day?: string;
}

export function createActorPanel(
  root: ShadowRoot,
  options: { platform: "LinkedIn" | "X"; quietDescription: string; notificationsEnabled: boolean },
): ActorPanelView {
  root.innerHTML = `
    <style>
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      .card { width: 278px; padding: 16px; border: 1px solid #4b3e31; border-radius: 14px;
        background: #211d18; color: #f5eee2; box-shadow: 0 12px 40px #0008;
        font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; }
      .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .brand { color: #f0aa78; font-family: Georgia, serif; font-size: 21px; font-style: italic; letter-spacing: -.04em; }
      .platform { color: #afa599; font-size: 10px; font-weight: 700; letter-spacing: .15em; text-transform: uppercase; }
      .status { display: flex; align-items: center; gap: 7px; min-height: 20px; margin: 9px 0 14px; color: #cfc5b8; font-size: 12px; }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #8b8072; flex: none; }
      .dot.active { background: #66c9a3; box-shadow: 0 0 0 3px #66c9a323; }
      .count { display: flex; align-items: baseline; gap: 11px; padding: 12px 0 13px;
        border-top: 1px solid #483c30; border-bottom: 1px solid #483c30; }
      .count strong { font: 32px/1 Georgia, serif; font-variant-numeric: tabular-nums; }
      .count span { color: #afa599; font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      .count .remaining { display: block; margin-top: 4px; color: #71cca8; font-size: 11px; font-weight: 600; letter-spacing: 0; text-transform: none; }
      .pool { display: flex; justify-content: space-between; margin-top: 10px; color: #afa599; font-size: 11px; }
      .pool strong { color: #f5eee2; font-variant-numeric: tabular-nums; }
      button { font: inherit; cursor: pointer; }
      .primary { width: 100%; margin-top: 15px; padding: 10px 12px; border: 0; border-radius: 7px;
        background: #2d806d; color: white; font-weight: 700; text-align: center; }
      .primary:hover { background: #35937c; }
      .primary[aria-pressed=true] { background: #336a5c; }
      .primary:disabled { opacity: .5; cursor: wait; }
      .stop { width: 100%; margin-top: 7px; padding: 8px; border: 1px solid #5c4c3f;
        border-radius: 7px; background: transparent; color: #e4d7c8; font-weight: 600; }
      .stop:hover { background: #3a3028; }
      .error { margin: 12px 0 0; padding: 9px 10px; border: 1px solid #9b5549;
        border-radius: 7px; background: #4c2b28; color: #ffe1d9; overflow-wrap: anywhere; }
      .error[hidden] { display: none; }
      details { border-top: 1px solid #483c30; margin-top: 14px; padding-top: 10px; }
      details + details { margin-top: 9px; border: 0; padding-top: 0; }
      summary { display: flex; justify-content: space-between; cursor: pointer; color: #cabbaa; font-size: 12px; }
      summary::marker { color: #a48d78; }
      .hours { color: #a99b8c; }
      .settings { display: grid; gap: 9px; padding-top: 12px; color: #cfc5b8; font-size: 12px; }
      .settings label { display: flex; align-items: center; gap: 7px; }
      .times { display: flex; gap: 8px; }
      .times label { display: grid; flex: 1; gap: 4px; }
      input[type=time] { width: 100%; padding: 5px 3px; border: 1px solid #655344; border-radius: 5px;
        background: #302820; color: #f5eee2; color-scheme: dark; font: inherit; }
      input[type=number] { width: 88px; padding: 6px; border: 1px solid #655344; border-radius: 5px;
        background: #302820; color: #f5eee2; font: inherit; font-variant-numeric: tabular-nums; }
      .cap-edit { display: flex; gap: 8px; align-items: center; }
      .cap-edit button { padding: 6px 9px; border: 1px solid #7a604b; border-radius: 5px; background: #3c3025; color: #f5eee2; }
      .cap-status { min-height: 16px; color: #ab9b89; }
      .settings small { color: #ab9b89; }
      .other-modes { display: grid; gap: 6px; padding-top: 9px; }
      .other-modes button { padding: 7px; border: 1px solid #5c4c3f; border-radius: 6px;
        background: #302820; color: #e4d7c8; text-align: left; }
      button:focus-visible, summary:focus-visible, input:focus-visible { outline: 2px solid #e7aa7e; outline-offset: 2px; }
    </style>
    <section class="card" aria-label="Noelle actor controls">
      <div class="top"><span class="brand">Noelle</span><span class="platform" id="na-platform"></span></div>
      <div class="status"><span class="dot" id="na-status-dot"></span><span id="na-discovery-status" role="status">Discovery off</span></div>
      <div class="count"><strong id="na-replies">—/—</strong><span>Browser replies today<small class="remaining" id="na-remaining">Loading…</small></span></div>
      <div class="pool"><span>Active reply leads</span><strong id="na-leads">0/5</strong></div>
      <button class="primary" id="na-discover" type="button" aria-pressed="false" disabled>Discover + reply automatically</button>
      <button class="stop" id="na-stop" type="button">Stop actor</button>
      <div class="error" id="na-error" role="alert" hidden></div>
      <details id="na-schedule"><summary>Quiet hours <span class="hours" id="na-hours">24/7</span></summary>
        <div class="settings">
          <label><input id="na-discovery-quiet" type="checkbox" disabled><span id="na-quiet-description"></span></label>
          <div class="times">
            <label>From<input id="na-discovery-start" aria-label="Quiet window start" type="time" value="01:00" disabled></label>
            <label>To<input id="na-discovery-end" aria-label="Quiet window end" type="time" value="09:00" disabled></label>
          </div>
          <small id="na-discovery-schedule-status">Runs 24/7 unless quiet hours are on.</small>
        </div>
      </details>
      <details id="na-cap"><summary>Daily reply cap <span id="na-cap-summary">Loading…</span></summary>
        <div class="settings">
          <div class="cap-edit"><input id="na-cap-input" type="number" min="0" max="500" step="1" aria-label="${options.platform === "X" ? "Daily browser reply ceiling" : "Daily browser reply cap"}" placeholder="Default"><button id="na-cap-save" type="button">Save</button></div>
          ${options.platform === "X" ? `<label><input id="na-cap-vary" type="checkbox"><span>Vary the daily cap</span></label>
          <label>Daily minimum<input id="na-cap-minimum" type="number" min="0" max="500" step="1" value="80" disabled></label>
          <small id="na-cap-policy">Fixed daily cap</small>` : ""}
          <small>Clear the field to use the server default. Changes apply to the next reply.</small>
          <small class="cap-status" id="na-cap-status" role="status"></small>
        </div>
      </details>
      <details id="na-advanced"><summary>Other modes</summary><div class="other-modes">
        <button id="na-fullauto" type="button">Auto</button>
        <button id="na-drain" type="button">Manual Auto</button>
        ${options.notificationsEnabled ? '<button id="na-notifs" type="button">Auto notifications</button>' : ""}
      </div></details>
    </section>`;
  const query = <T extends Element = HTMLElement>(selector: string): T => {
    const node = root.querySelector<T>(selector);
    if (!node) throw new Error(`Actor panel element missing: ${selector}`);
    return node;
  };
  query("#na-platform").textContent = options.platform;
  query("#na-quiet-description").textContent = options.quietDescription;
  const error = query<HTMLElement>("#na-error");
  const capInput = query<HTMLInputElement>("#na-cap-input");
  const capSettings = query<HTMLDetailsElement>("#na-cap");
  const varyInput = capSettings.querySelector<HTMLInputElement>("#na-cap-vary");
  const minimumInput = capSettings.querySelector<HTMLInputElement>("#na-cap-minimum");
  let capEditDirty = false;
  for (const input of [capInput, minimumInput, varyInput]) {
    input?.addEventListener("input", () => { capEditDirty = true; });
    input?.addEventListener("change", () => { capEditDirty = true; });
  }
  varyInput?.addEventListener("change", () => {
    if (minimumInput) minimumInput.disabled = !varyInput.checked;
  });
  let localError = "";
  let capacityError = "";
  let capacity: { occupied: number; limit: number } | null = null;
  let readyInActor = 0;
  const showLeads = () => {
    query("#na-leads").textContent = capacity
      ? `${capacity.occupied}/${capacity.limit}` : `${readyInActor}/5`;
  };
  const showError = (eventError = "") => {
    error.textContent = eventError || localError || capacityError;
    error.hidden = !error.textContent;
  };
  return {
    query,
    reportError(message) { localError = message; showError(); },
    clearError() { localError = ""; showError(); },
    setLeadCapacity(value, failure = "") {
      capacity = value;
      capacityError = failure;
      showLeads();
      showError();
    },
    setReplyCap(value, failure = "", savedEdit = false) {
      const count = query("#na-replies");
      const remaining = query("#na-remaining");
      const summary = query("#na-cap-summary");
      if (!value) {
        count.textContent = "—/—";
        remaining.textContent = "Count unavailable";
        summary.textContent = "Unavailable";
        query("#na-cap-status").textContent = failure;
        return;
      }
      count.textContent = `${value.sent}/${value.cap ?? "∞"}`;
      remaining.textContent = value.cap === null ? "No daily reply cap" : `${value.remaining ?? 0} left today`;
      const ceiling = value.configuredCap === undefined ? value.cap : value.configuredCap;
      const varying = !!varyInput && value.minimum != null && ceiling != null;
      summary.textContent = varying ? `${value.minimum}–${ceiling} · today ${value.cap}`
        : value.cap === null ? "Server default · unlimited" : String(value.cap);
      if (varyInput) query("#na-cap-policy").textContent = varying
        ? `Daily range ${value.minimum}–${ceiling}. Today's limit: ${value.cap}.`
        : "Fixed daily cap";
      if (savedEdit) capEditDirty = false;
      if (!capEditDirty && ![capInput, minimumInput, varyInput].some(input => input && root.activeElement === input)) {
        capInput.value = ceiling === null ? "" : String(ceiling);
        if (varyInput && minimumInput) {
          varyInput.checked = varying;
          minimumInput.value = String(value.minimum ?? 80);
          minimumInput.disabled = !varying;
        }
      }
      query("#na-cap-status").textContent = failure;
    },
    setHours(summary) { query("#na-hours").textContent = summary; },
    render(state, discoveryActive) {
      const running = state?.status === "running";
      query("#na-discovery-status").textContent = discoveryActive
        ? running ? "Discovery active" : "Discovery enabled · actor idle"
        : running ? "Actor running" : "Discovery off";
      query("#na-status-dot").classList.toggle("active", running);
      query<HTMLButtonElement>("#na-discover").setAttribute("aria-pressed", String(discoveryActive));
      readyInActor = state?.commentPool?.length ?? 0;
      showLeads();
      const event = state?.lastEvent ?? "";
      const eventError = state?.status === "halted-challenge"
        ? event || "Challenge detected; actor stopped"
        : /\b(fail(?:ed|ure)?|error|challenge|blocked|unavailable)\b|\berr:/i.test(event) ? event : "";
      showError(eventError);
    },
  };
}

/** Backend-only status polling; it never causes a LinkedIn or X page visit. */
export function watchActorReplyCap(
  view: ActorPanelView,
  bridge: {
    read(): Promise<{ ok?: boolean; cap?: ActorReplyCap; error?: string } | null>;
    write(cap: number | null, minimum?: number | null): Promise<{ ok?: boolean; cap?: ActorReplyCap; error?: string } | null>;
  },
): void {
  let inFlight = false;
  let revision = 0;
  const timebox = <T>(request: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("actor response timed out")), 8_000);
    });
    return Promise.race([request, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  };
  const valid = (value: ActorReplyCap | undefined): value is ActorReplyCap => !!value &&
    Number.isSafeInteger(value.sent) && value.sent >= 0 &&
    (value.cap === null || Number.isSafeInteger(value.cap) && value.cap >= 0 && value.cap <= 500) &&
    (value.remaining === null || Number.isSafeInteger(value.remaining) && value.remaining >= 0);
  const poll = async () => {
    if (inFlight) return;
    inFlight = true;
    const startedAtRevision = revision;
    try {
      const result = await timebox(bridge.read());
      if (startedAtRevision !== revision) return;
      view.setReplyCap(result?.ok && valid(result.cap) ? result.cap : null,
        result?.ok && valid(result.cap) ? "" : `Reply count unavailable: ${result?.error ?? "check the API"}`);
    } catch (error) {
      if (startedAtRevision !== revision) return;
      view.setReplyCap(null, `Reply count unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally { inFlight = false; }
  };
  view.query<HTMLButtonElement>("#na-cap-save").addEventListener("click", () => {
    void (async () => {
      const input = view.query<HTMLInputElement>("#na-cap-input");
      const raw = input.value.trim();
      const cap = raw === "" ? null : Number(raw);
      if (cap !== null && (!Number.isInteger(cap) || cap < 0 || cap > 500)) {
        view.query("#na-cap-status").textContent = "Enter a whole number from 0 to 500";
        return;
      }
      const settings = view.query<HTMLDetailsElement>("#na-cap");
      const vary = settings.querySelector<HTMLInputElement>("#na-cap-vary");
      const minimumInput = settings.querySelector<HTMLInputElement>("#na-cap-minimum");
      const varyChecked = vary?.checked;
      const minimumRaw = minimumInput?.value.trim();
      const minimum = varyChecked ? Number(minimumRaw) : undefined;
      if (minimum !== undefined && (minimumRaw === "" || cap === null || !Number.isInteger(minimum) || minimum < 0 || minimum > cap)) {
        view.query("#na-cap-status").textContent = "Enter a daily minimum from 0 to the configured ceiling";
        return;
      }
      const save = view.query<HTMLButtonElement>("#na-cap-save");
      save.disabled = true;
      revision++;
      try {
        const result = await timebox(bridge.write(cap, minimum));
        if (!result?.ok || !valid(result.cap)) throw new Error(result?.error ?? "API did not save the cap");
        revision++;
        const unchanged = input.value.trim() === raw && vary?.checked === varyChecked
          && minimumInput?.value.trim() === minimumRaw;
        view.setReplyCap(result.cap, "Saved", unchanged);
      } catch (error) {
        revision++;
        view.query("#na-cap-status").textContent = `Could not confirm save: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        save.disabled = false;
      }
    })();
  });
  void poll();
  setInterval(() => { void poll(); }, 15_000);
}

/** One backend-only count read per minute; the feed navigation cadence is untouched. */
export function watchActorLeadCapacity(
  view: ActorPanelView,
  query: () => Promise<{ ok?: boolean; capacity?: { occupied: number; limit: number }; error?: string } | null>,
): void {
  let inFlight = false;
  const poll = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const result = await query();
      const capacity = result?.capacity;
      if (result?.ok && capacity && Number.isSafeInteger(capacity.occupied) &&
          Number.isSafeInteger(capacity.limit) && capacity.occupied >= 0 && capacity.limit > 0) {
        view.setLeadCapacity(capacity);
      } else {
        view.setLeadCapacity(null, `Lead count unavailable: ${result?.error ?? "reload the extension or check the API"}`);
      }
    } catch (error) {
      view.setLeadCapacity(null, `Lead count unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight = false;
    }
  };
  void poll();
  setInterval(() => { void poll(); }, 60_000);
}

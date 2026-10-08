// Auto-close the native JavaScript dialogs that would otherwise FREEZE a
// debugger-driven actuator run.
//
// THE bug this exists to fix: the actuator types a reply, the submit fails (a
// drifted selector, an action-block, a stopped run), and the composer is left
// holding un-posted text. X and LinkedIn both register a `beforeunload` handler
// while a composer is dirty, so the NEXT `chrome.tabs.update(...)` — the hop to
// the next permalink, or the return to the feed — makes Chrome raise
// "Leave site? Changes you made may not be saved."
//
// A JS dialog blocks the renderer. The content script (which drives the tick
// loop) stops running, and every queued `Input.dispatchMouseEvent` waits behind
// it forever. The run does not fail, it WEDGES — until a human clicks Leave or
// Stay. That is the "wall" the operator sees.
//
// The fix is the same one Puppeteer and Playwright apply by default: enable the
// CDP `Page` domain, which routes dialogs to the debugger client INSTEAD of the
// native UI, and answer every `Page.javascriptDialogOpening` with
// `Page.handleJavaScriptDialog` — after a drawn human reaction delay, because a
// 0ms answer is a tell of its own (see `defaultReactionMs`). Nothing is injected
// into the page and no page-visible surface changes, so the extension's
// fingerprint is otherwise unchanged.
//
// This module is deliberately DOM-agnostic and effect-injected: X, LinkedIn and
// Reddit all share it, and every branch is unit-testable without a browser.

/** The `source` Chrome hands a `chrome.debugger.onEvent` listener. */
export type Debuggee = { tabId?: number | undefined };

/** Shape of a `chrome.debugger.onEvent` listener. */
export type DebuggerEventListener = (source: Debuggee, method: string, params?: unknown) => void;

/** Payload of `Page.javascriptDialogOpening`. */
export type JavascriptDialogOpening = {
  url?: string;
  message?: string;
  /** "alert" | "confirm" | "prompt" | "beforeunload" */
  type?: string;
  hasBrowserHandler?: boolean;
  defaultPrompt?: string;
};

export type DialogGuardDeps = {
  /** Send one CDP command to a tab. May reject (tab gone, debugger detached). */
  send(tabId: number, method: string, params?: object): Promise<unknown>;
  /** Register the global debugger-event listener (i.e. chrome.debugger.onEvent). */
  addEventListener(listener: DebuggerEventListener): void;
  /** Optional observability sink — DevTools cannot be open during a run. */
  log?(level: "info" | "warn", msg: string, meta?: Record<string, unknown>): void;
  /** Reaction delay before answering, in ms. Defaults to a human read-and-click
   *  draw (see `defaultReactionMs`). Injected so tests run instantly. */
  reactionMs?(): number;
  sleep?(ms: number): Promise<void>;
};

export type DialogGuard = {
  /** Enable `Page` on a tab so its dialogs reach us instead of the screen. */
  arm(tabId: number): Promise<void>;
  /** Disable `Page` on a tab (paired with a debugger detach). */
  disarm(tabId: number): Promise<void>;
};

/**
 * Should this dialog be ACCEPTED (its affirmative button) or DISMISSED?
 *
 * - `beforeunload` → accept. The actuator is the one that asked to navigate, so
 *   "Leave" is the answer that matches its intent; "Stay" would cancel the
 *   navigation and leave the run clicking at the wrong page.
 * - `alert` → accept. It has only an OK button; accepting is the only way out.
 * - `confirm` / `prompt` / anything unrecognised → dismiss. We did not author
 *   these and cannot read them, and an affirmative answer to an unknown
 *   question ("Delete this post?") is a destructive act. Closing without
 *   affirming still unblocks the renderer, which is all the run needs.
 */
export function dialogShouldAccept(type: string | undefined): boolean {
  return type === "beforeunload" || type === "alert";
}

/**
 * How long to wait before answering, in ms.
 *
 * An instantly-answered dialog is a bot tell in its own right: a page can call
 * `confirm()` and time the round trip, and a human cannot read "Leave site?" and
 * click in 0ms. This band is a plausible read-and-click (see docs/reply-
 * actuation-strategy.md §"Adversarial detection sweep"). It costs ~1s per
 * dialog, which is nothing next to the 20-minute wedge it replaces.
 *
 * Deliberately NOT seeded off the run's Rng: dialogs are exceptional events, and
 * threading the seeded stream through them would make every run's motion
 * sequence depend on whether a dialog happened to fire.
 */
export function defaultReactionMs(): number {
  return 480 + Math.random() * 920; // ~0.5–1.4s
}

export function createDialogGuard(deps: DialogGuardDeps): DialogGuard {
  /** Tabs whose LAST Page.enable succeeded — i.e. tabs worth disabling again. */
  const enabled = new Set<number>();
  /** Tabs already warned about, so a dead tab doesn't warn on every tick. */
  const warned = new Set<number>();
  const log = deps.log ?? (() => {});
  const reactionMs = deps.reactionMs ?? defaultReactionMs;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Registered ONCE, covering every tab this extension attaches. Deliberately
  // NOT gated on the `enabled` set: an event can only reach us from a tab whose
  // Page domain is enabled anyway, and an unhandled dialog is a wedged run, so
  // over-inclusion is strictly safer than a bookkeeping miss.
  deps.addEventListener((source, method, params) => {
    if (method !== "Page.javascriptDialogOpening") return;
    const tabId = source.tabId;
    if (typeof tabId !== "number") return; // target-scoped debuggee; not ours to answer
    const p = (params ?? {}) as JavascriptDialogOpening;
    const accept = dialogShouldAccept(p.type);
    const type = p.type ?? "unknown";
    const message = (p.message ?? "").slice(0, 120);
    // Fire-and-forget: the listener is invoked BY Chrome, so an escaping
    // rejection would be an unhandled one. The tab closing mid-dialog is the
    // realistic reject, and there is nothing to retry — the dialog died with it.
    //
    // One log line per dialog is the whole observability story: DevTools cannot
    // be open during a run (chrome.debugger holds the tab), and the bridge sink
    // is both greppable and what actuator-doctor already reads.
    void sleep(reactionMs())
      .then(() => deps.send(tabId, "Page.handleJavaScriptDialog", { accept }))
      .then(() => {
        log("info", "closed a page dialog that would have wedged the run", {
          tabId,
          type,
          accept,
          message,
        });
      })
      .catch((e: unknown) => {
        log("warn", "could not close a page dialog", {
          tabId,
          type,
          error: e instanceof Error ? e.message : String(e),
        });
      });
  });

  return {
    async arm(tabId) {
      // ALWAYS re-send; never short-circuit on "we already armed this tab". CDP
      // domain state is per debugger SESSION: if the operator dismisses the
      // "Extension is debugging this browser" infobar the session drops, and
      // the re-attach that follows starts a FRESH session with Page disabled
      // again. A has()-guard here would skip the re-enable and leave the guard
      // silently dead on exactly the tab that just proved it needs one.
      // Page.enable is idempotent, so the repeat costs one no-op command — and
      // the caller (Cdp.attach) runs every tick, so idempotence is the point.
      try {
        await deps.send(tabId, "Page.enable");
        enabled.add(tabId);
        warned.delete(tabId); // recovered — a future failure is news again
      } catch (e: unknown) {
        // Best-effort, exactly like the attach it pairs with: a tab that died
        // between attach and arm must not take the run down with it. But SAY so
        // once — a silently swallowed failure here means no dialog event ever
        // arrives and the wedge is back, which is otherwise invisible. Only
        // once: per-tick arming would otherwise flood the sink for a dead tab.
        enabled.delete(tabId);
        if (!warned.has(tabId)) {
          warned.add(tabId);
          log("warn", "could not enable the Page domain — dialogs can still wedge this tab", {
            tabId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    },
    async disarm(tabId) {
      warned.delete(tabId);
      // Nothing to disable on a tab whose enable never landed — and the detach
      // that follows would reject anyway.
      if (!enabled.delete(tabId)) return;
      await deps.send(tabId, "Page.disable").catch(() => {});
    },
  };
}

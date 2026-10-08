import type { Rng } from "../lib/rng.js";
import {
  // legacy planners are intentionally NOT used here anymore (kept in motion.ts
  // for other callers/tests); the human motion engine drives all CDP input now.
  mousePlan, clickPoint, tremor, hoverDwellMs, planScrollGestures,
  typingDelays, type Point,
} from "../lib/motion.js";
import { keyStrokeFor } from "../lib/keyboard-layout.js";
import { clearFocusedEditor, createDialogGuard } from "@noelle/actuator-cdp";
import { sinkLog } from "../lib/bridge-sink.js";

/**
 * Native-dialog guard. Created at MODULE scope on purpose: it registers the
 * `chrome.debugger.onEvent` listener during the service worker's INITIAL
 * evaluation, which is the only registration MV3 will use to wake a suspended
 * worker.
 *
 * Without it, a `beforeunload` dialog ("Leave site? Changes you made may not be
 * saved") blocks the renderer: the content script that drives the tick loop
 * stops running and every queued `Input.*` waits behind it, so the run doesn't
 * fail — it WEDGES until a human clicks the button. X raises exactly that
 * dialog whenever a tab navigates while a composer still holds un-posted text,
 * which is the state EVERY failed reply attempt leaves behind (submit.ts never
 * clears the box), and the next `chrome.tabs.update` then trips it.
 *
 * See `packages/actuator-cdp/src/dialog-guard.ts` for the accept/dismiss policy.
 */
const dialogGuard = createDialogGuard({
  send: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params ?? {}),
  // Optional-chained: unit tests stub only `chrome.debugger.sendCommand`, and a
  // partial stub must not throw at import time.
  addEventListener: (cb) => {
    (globalThis as { chrome?: typeof chrome }).chrome?.debugger?.onEvent?.addListener(cb);
  },
  log: (level, msg, meta) => sinkLog(level, msg, meta),
});

/**
 * Clamp a millisecond draw into a human-plausible [lo,hi] band. Local twin of
 * motion.ts's private `clamp` (kept private there); used to bound the widened
 * lognormal timing draws in moveAndClick so a heavy right tail can never emit an
 * absurd hold while the low floor stays pinned at its established safe value.
 */
function clampMs(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

type Sleep = (ms: number) => Promise<void>;
type Rect = { x: number; y: number; width: number; height: number };

export class Cdp {
  private lastPos: Point = { x: 200, y: 300 };
  /**
   * Tabs this instance currently holds a CDP session on. A run re-pins (and so
   * re-attaches to) a new tab when its pinned tab closes, and the tick that
   * re-pins may not persist the new id before the run ends — so endRun cannot
   * rely on the stored RunState.tabId to know what to detach. Tracking every
   * attached tab here lets detachAll() clean them ALL up, so the "Extension is
   * debugging this browser" banner never lingers after a run halts.
   */
  private attached = new Set<number>();

  private send(tabId: number, method: string, params: object): Promise<unknown> {
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  async attach(tabId: number): Promise<void> {
    // Best-effort + idempotent: a re-attach to an already-attached tab rejects
    // (callers already treat attach as best-effort); swallow it but still record
    // the tab so detachAll() covers it. Over-inclusion is harmless — detach no-ops
    // on a tab we're not actually attached to.
    await chrome.debugger.attach({ tabId }, "1.3").catch(() => {});
    this.attached.add(tabId);
    // Route this tab's JS dialogs to the guard instead of to a modal nobody is
    // sitting there to click. MUST follow the attach — Page.enable on an
    // unattached tab rejects, and the guard can only warn about that; no dialog
    // event would ever arrive and the wedge would be back. Re-armed on every
    // call because this method runs each tick and a re-attach starts a fresh
    // CDP session with Page disabled again.
    await dialogGuard.arm(tabId);
  }
  async detach(tabId: number): Promise<void> {
    // Disarm BEFORE the detach: once detached, Page.disable has nothing to talk
    // to, and leaving the domain enabled on a tab we no longer own would keep
    // Chrome routing that tab's dialogs to a client that answers nothing.
    await dialogGuard.disarm(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    this.attached.delete(tabId);
  }
  /** Detach every tab this instance attached — used by endRun so a run that
   *  hopped/re-pinned tabs leaves no debugger session (or banner) behind. */
  async detachAll(): Promise<void> {
    for (const tabId of [...this.attached]) await this.detach(tabId);
  }

  /**
   * Move the cursor to a human-sampled point inside `rect` and LAND on it (no
   * button press), driven by the §3(c) motion engine:
   *  - clickPoint: 2D-Gaussian inside the rect (never dead-center).
   *  - mousePlan: sigma-lognormal velocity envelope → non-uniform inter-move
   *    sleeps + variable point density + overshoot/correct.
   *  - tremor: 8–12Hz micro-jitter applied to EVERY dispatched coordinate
   *    (moves, the overshoot holds, the corrective approach) — a still pixel is
   *    an instant bot tell.
   * Returns the landed point and the elapsed motion time so the caller's dwell
   * (a click's pre-press hover, or hover()'s reveal hold) keeps the tremor clock
   * monotonic. Shared by moveAndClick (presses next) and hover (dwells next).
   */
  private async approach(tabId: number, rect: Rect, rng: Rng, sleep: Sleep): Promise<{ target: Point; tElapsed: number }> {
    const target = clickPoint(rect, rng);
    const size = Math.max(1, Math.min(rect.width, rect.height));
    const plan = mousePlan(this.lastPos, target, size, rng);

    // 1) primary approach — non-uniform sleeps, tremor on every coord
    let tElapsed = 0;
    for (let i = 0; i < plan.points.length; i++) {
      const p = plan.points[i]!;
      const j = tremor(p, tElapsed, rng);
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: j.x, y: j.y, buttons: 0 });
      const dt = plan.sleepsMs[i] ?? 0;
      if (dt > 0) await sleep(dt);
      tElapsed += dt;
    }

    // 2) overshoot a few px past the target; a couple of jittered holds (v≈0)
    {
      const o = plan.overshoot;
      const j = tremor(o, tElapsed, rng);
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: j.x, y: j.y, buttons: 0 });
      // gamma-ish settle while the antagonist muscles arrest the motion. Draw the
      // TOTAL settle once (lognormal median ~95ms, heavy right tail so sessions
      // diverge), then bleed it out across a variable number of UNEVEN re-jittered
      // micro-holds — an equal split would be its own tell.
      const settleMs = clampMs(rng.logNormal(Math.log(95), 0.5), 50, 320);
      const holds = rng.int(2, 4);
      let settleLeft = settleMs;
      for (let h = 0; h < holds; h++) {
        const hd = h === holds - 1 ? settleLeft : settleLeft * rng.float(0.3, 0.7);
        settleLeft -= hd;
        await sleep(hd);
        tElapsed += hd;
        const jj = tremor(o, tElapsed, rng); // re-jitter so the hold isn't frozen
        await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: jj.x, y: jj.y, buttons: 0 });
      }
    }

    // 3) corrective sub-movement: a short, dense, low-velocity move from the
    // overshoot point back onto the click point (BeCAPTCHA's #1 human feature).
    {
      const corr = mousePlan(plan.correctFrom, target, size, rng);
      // truncate to a few dense interpolated points so it stays a *small* slow
      // correction, not a second full flight.
      const k = Math.min(corr.points.length, rng.int(4, 9));
      const step = Math.max(1, Math.floor(corr.points.length / k));
      for (let i = 0; i < corr.points.length; i += step) {
        const p = corr.points[i]!;
        const j = tremor(p, tElapsed, rng);
        await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: j.x, y: j.y, buttons: 0 });
        const dt = (corr.sleepsMs[i] ?? 0) + clampMs(rng.logNormal(Math.log(13), 0.4), 8, 45); // deliberately slow
        await sleep(dt);
        tElapsed += dt;
      }
      // land exactly on the click point
      const land = tremor(target, tElapsed, rng);
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: land.x, y: land.y, buttons: 0 });
    }

    return { target, tElapsed };
  }

  /** Approach `rect` and click it (2D-Gaussian point, overshoot/correct, tremor,
   * pre-press hover dwell, then a pressure-bearing press→hold→release). */
  async moveAndClick(tabId: number, rect: Rect, rng: Rng, sleep: Sleep): Promise<void> {
    const { target, tElapsed: t0 } = await this.approach(tabId, rect, rng, sleep);
    let tElapsed = t0;

    // 4) pre-click hover dwell (~220ms logNormal) with tremor drift
    {
      const dwell = hoverDwellMs(rng);
      // split the dwell into a variable number of UNEVEN slices — an equal split
      // is N identical inter-move gaps, itself a fingerprint. The final slice
      // drains the remainder so the TOTAL dwell is unchanged.
      const slices = rng.int(2, 5);
      let dwellLeft = dwell;
      for (let h = 0; h < slices; h++) {
        const hd = h === slices - 1 ? dwellLeft : dwellLeft * rng.float(0.3, 0.7);
        dwellLeft -= hd;
        await sleep(hd);
        tElapsed += hd;
        const j = tremor(target, tElapsed, rng);
        await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: j.x, y: j.y, buttons: 0 });
      }
    }

    // 5) press → hold → release at the (tremored) click point
    {
      const jp = tremor(target, tElapsed, rng);
      // force:0.5 matches a real mouse button-down (PointerEvent.pressure); CDP's
      // default of 0 is a per-event tell if a page reads pressure on pointerdown.
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: jp.x, y: jp.y, button: "left", clickCount: 1, buttons: 1, force: 0.5 });
      const hold = clampMs(rng.logNormal(Math.log(95), 0.42), 50, 260);
      await sleep(hold);
      tElapsed += hold;
      const jr = tremor(target, tElapsed, rng);
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: jr.x, y: jr.y, button: "left", clickCount: 1, buttons: 0 });
    }

    this.lastPos = target;
  }

  /**
   * Approach `rect` and DWELL there (no click) long enough for a hover-triggered
   * affordance to appear — e.g. a profile hover-card, or a menu that opens on
   * hover. Keeps dispatching tremored mouseMoved events on the target so the
   * page's :hover / mouseover state is sustained (a frozen cursor would neither
   * open the affordance nor read as human). Leaves the cursor parked ON the
   * target, so a follow-up moveAndClick travels a short in-affordance path.
   * DOM-agnostic; ported from the LinkedIn actuator's reaction-flyout primitive.
   */
  async hover(tabId: number, rect: Rect, rng: Rng, sleep: Sleep, holdMs?: number): Promise<void> {
    const { target, tElapsed: t0 } = await this.approach(tabId, rect, rng, sleep);
    let tElapsed = t0;
    const total = holdMs ?? rng.float(650, 1150);
    const slices = rng.int(5, 8);
    for (let h = 0; h < slices; h++) {
      const hd = total / slices;
      await sleep(hd);
      tElapsed += hd;
      const j = tremor(target, tElapsed, rng);
      await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: j.x, y: j.y, buttons: 0 });
    }
    this.lastPos = target;
  }

  /**
   * Select everything in the focused editor and delete it — used to empty a
   * composer that a failed send left dirty, so the next navigation cannot raise
   * a `beforeunload` ("Leave site?") dialog. Escape is deliberately NOT used:
   * on X it opens the in-page "Discard post?" confirm instead of clearing.
   */
  async clearFocusedEditor(tabId: number, sleep: Sleep): Promise<void> {
    await clearFocusedEditor((t, method, params) => this.send(t, method, params ?? {}), tabId, sleep);
  }

  /**
   * Press Escape — dismisses X's transient menus/popovers (e.g. the repost
   * confirm menu) WITHOUT a click. Used when a menu is (or may be) open and its
   * backdrop would swallow a synthetic click: closing via keyboard is both what
   * a human does and the only path that can't accidentally click through onto
   * whatever sits under the backdrop.
   */
  async pressEscape(tabId: number): Promise<void> {
    await this.send(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Escape", code: "Escape",
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    await this.send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp", key: "Escape", code: "Escape",
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
  }

  /**
   * Scroll `totalPx` driven by §3(a) momentum gestures (flick/slow-drag/
   * micro-nudge/back-scroll mixture). Each gesture dispatches a decelerating
   * `mouseWheel` delta series with non-uniform inter-delta sleeps + a post-dwell,
   * with tremor on the wheel anchor x,y. Same `(tabId, at, totalPx, rng, sleep)`
   * signature so existing callers keep working.
   */
  async wheel(
    tabId: number,
    at: Point,
    totalPx: number,
    rng: Rng,
    sleep: Sleep,
    contentHints?: { wordCount?: number; hasMedia?: boolean }[],
  ): Promise<void> {
    const gestures = planScrollGestures(rng, totalPx, contentHints);
    let tElapsed = 0;
    for (const g of gestures) {
      for (let i = 0; i < g.deltas.length; i++) {
        const j = tremor(at, tElapsed, rng);
        await this.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel", x: j.x, y: j.y, deltaX: 0, deltaY: g.deltas[i]!,
        });
        const dt = g.interDeltaMs[i] ?? 0;
        if (dt > 0) await sleep(dt);
        tElapsed += dt;
      }
      if (g.postDwellMs != null && g.postDwellMs > 0) {
        await sleep(g.postDwellMs);
        tElapsed += g.postDwellMs;
      }
    }
  }

  /**
   * Submit chord: a modifier+Enter keydown/keyup with real key metadata. X
   * natively posts the focused composer on Cmd+Enter (macOS) / Ctrl+Enter.
   * `modifiers` is the CDP bitmask: 4 = Meta/⌘, 2 = Ctrl. Sends a rawKeyDown
   * (no `text` field), so a bare Enter can never leak a newline into the
   * composer — the chord either submits or does nothing.
   */
  async pressSubmitChord(tabId: number, modifiers: number): Promise<void> {
    await this.send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers });
    await this.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers });
  }

  /**
   * Type `text` one character at a time with full US-keyboard metadata so each
   * keydown/keyup carries a real key/code/keyCode (not keyCode=0 / code="" /
   * key="Unidentified", which no hardware produces and both LinkedIn and X can
   * read from keystroke telemetry). Shift is held across consecutive shifted
   * characters like a real typist.
   *
   * The character itself is committed with `Input.insertText`, NOT via the
   * keyDown's `text` field. X's reply composer is a React-controlled
   * contenteditable (DraftJS-style): it intercepts `beforeinput` and applies
   * its own transaction. A keyDown-with-text produces a native edit the editor
   * model doesn't always sync from, so the character lands in the DOM but the
   * model stays empty — which keeps the reply button DISABLED forever (text
   * typed, box populated, submit never enables → submit-not-found).
   * `Input.insertText` fires the `inputType:"insertText"` beforeinput/input the
   * editor handles natively, so the model updates and the submit enables. We
   * therefore send a text-less rawKeyDown (telemetry only), then insertText
   * (the real, framework-observable edit), then keyUp. (Ports #444.)
   */
  async typeText(tabId: number, text: string, rng: Rng, sleep: Sleep): Promise<void> {
    const delays = typingDelays(rng, text.length);
    const shift = { down: false };
    const releaseShift = async () => {
      if (!shift.down) return;
      await this.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, location: 1 });
      shift.down = false;
    };
    let i = 0;
    for (const ch of text) {
      const def = keyStrokeFor(ch);
      if (!def) {
        await releaseShift();
        await this.send(tabId, "Input.insertText", { text: ch });
        await sleep(delays[i++] ?? 60);
        continue;
      }
      if (def.shift && !shift.down) {
        await this.send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: 8, location: 1 });
        shift.down = true;
      } else if (!def.shift && shift.down) {
        await releaseShift();
      }
      const modifiers = shift.down ? 8 : 0;
      // rawKeyDown (no `text`) → no native character insertion, just the
      // keystroke telemetry with real US-keyboard metadata.
      await this.send(tabId, "Input.dispatchKeyEvent", {
        type: "rawKeyDown", key: def.key, code: def.code,
        windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode,
        unmodifiedText: def.unmodified, modifiers,
      });
      // The actual edit, via a path the React editor observes and syncs from.
      await this.send(tabId, "Input.insertText", { text: ch });
      await this.send(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp", key: def.key, code: def.code,
        windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers,
      });
      await sleep(delays[i++] ?? 60);
    }
    await releaseShift();
  }
}

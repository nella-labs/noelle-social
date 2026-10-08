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
 * fail — it WEDGES until a human clicks the button. Reddit raises exactly that
 * dialog whenever a tab navigates while a comment composer still holds un-sent
 * text, which is the state EVERY failed reply attempt leaves behind, and the
 * next `chrome.tabs.update` then trips it.
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

  /**
   * Select everything in the focused editor and delete it — used to empty a
   * composer that a failed send left dirty, so the next navigation cannot raise
   * a `beforeunload` ("Leave site?") dialog.
   */
  async clearFocusedEditor(tabId: number, sleep: Sleep): Promise<void> {
    await clearFocusedEditor((t, method, params) => this.send(t, method, params ?? {}), tabId, sleep);
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
   * Move the cursor to a human-sampled point inside `rect` and click it, driven
   * by the §3(c) motion engine:
   *  - clickPoint: 2D-Gaussian inside the rect (never dead-center).
   *  - mousePlan: sigma-lognormal velocity envelope → non-uniform inter-move
   *    sleeps + variable point density + overshoot/correct.
   *  - tremor: 8–12Hz micro-jitter applied to EVERY dispatched coordinate
   *    (moves, the overshoot holds, the corrective approach, the hover dwell,
   *    and the press/release) — a still pixel is an instant bot tell.
   */
  async moveAndClick(tabId: number, rect: Rect, rng: Rng, sleep: Sleep): Promise<void> {
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
   * Type `text` one character at a time with full US-keyboard metadata so each
   * keydown/keyup carries a real key/code/keyCode (not keyCode=0 / code="" /
   * key="Unidentified", which no hardware produces and both LinkedIn and X can
   * read from keystroke telemetry). Shift is held across consecutive shifted
   * characters like a real typist.
   *
   * The character itself is committed with `Input.insertText`, NOT via the
   * keyDown's `text` field (ports #444). Reddit's new-Reddit comment composer is
   * a framework-managed contenteditable (Lexical-style rich-text editor): it
   * intercepts `beforeinput` and applies its own transaction. A keyDown-with-text
   * produces a native edit the editor's model doesn't always sync from, so the
   * character lands in the DOM but the model stays empty — which keeps the
   * "Comment" submit DISABLED forever (the LinkedIn actuator's live symptom:
   * text typed, box populated, submit never enables → submit-not-found).
   * `Input.insertText` fires the `inputType:"insertText"` beforeinput/input the
   * editor handles natively, so the model updates and the submit enables. We
   * therefore send a text-less rawKeyDown (telemetry only, real key/code/keyCode,
   * Shift-hold preserved), then insertText (the real, framework-observable edit),
   * then keyUp.
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
      // The actual edit, via a path the framework editor observes and syncs from.
      await this.send(tabId, "Input.insertText", { text: ch });
      await this.send(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp", key: def.key, code: def.code,
        windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers,
      });
      await sleep(delays[i++] ?? 60);
    }
    await releaseShift();
  }

  /**
   * Press Escape (rawKeyDown → keyUp with real key/code/keyCode). Used to dismiss
   * an opened overflow "…" menu without clicking through it when a post-save can't
   * be completed — the menu's backdrop swallows synthetic clicks, so Escape is the
   * only safe close. Mirrors the X actuator's repost-menu dismiss.
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
}

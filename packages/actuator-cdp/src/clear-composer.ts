// Leave the composer EMPTY whenever a send attempt did not land.
//
// Why this exists, and why the dialog guard is not enough:
//
// X, LinkedIn and Reddit register a `beforeunload` handler while a composer
// holds un-sent text. The actuator's next `chrome.tabs.update` — the hop to the
// next permalink, or the return to the feed — is a navigation away from that
// dirty composer, so Chromium raises "Leave site? Changes you made may not be
// saved." That dialog blocks the renderer, freezes the content script's tick
// loop, and wedges the run until a human clicks it.
//
// The obvious fix — enable the CDP `Page` domain and answer the dialog with
// `Page.handleJavaScriptDialog` — DOES NOT WORK for `beforeunload`. It is a
// confirmed upstream Chromium bug (puppeteer/puppeteer#9871, labelled
// `confirmed` + `upstream`): the `javascriptDialogOpening` event fires, but
// neither accept nor dismiss closes the dialog, and browser-initiated
// navigations (which `chrome.tabs.update` is) bypass the interception path
// entirely. The guard in `dialog-guard.ts` is still worth having for
// `alert`/`confirm`/`prompt`, but it can never answer this one.
//
// So the only reliable fix is to remove the TRIGGER: if the box is empty, no
// `beforeunload` is registered and no dialog is ever raised. That is also just
// correct behaviour — a failed reply should not leave half a draft sitting in
// the operator's own browser.

export type CdpSend = (tabId: number, method: string, params?: object) => Promise<unknown>;

/** CDP modifier bitmask. */
const META = 4;
const CTRL = 2;

/**
 * Select everything in the focused editor and delete it.
 *
 * Uses `Input.dispatchKeyEvent`'s `commands` array rather than hoping the
 * modifier chord maps to an editing accelerator: `selectAll` / `deleteBackward`
 * are applied by Chromium's editor directly, which works across the
 * contenteditable/React editors all three platforms use. The key metadata is
 * still real (`⌘A` on macOS, `Ctrl+A` elsewhere) so the keystroke telemetry a
 * page can read looks like a person clearing a draft, not a scripted wipe.
 *
 * Both chords are sent because the actuator can run on either platform, and the
 * `commands` array makes the redundant one a harmless no-op.
 */
export async function clearFocusedEditor(send: CdpSend, tabId: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (const modifiers of [META, CTRL]) {
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "a", code: "KeyA",
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      modifiers, commands: ["selectAll"],
    });
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA",
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers,
    });
  }
  await sleep(40);
  await send(tabId, "Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: "Backspace", code: "Backspace",
    windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    commands: ["deleteBackward"],
  });
  await send(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: "Backspace", code: "Backspace",
    windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
  });
}

export type ClearComposerDeps = {
  /** Focus the composer (a real click). false when no composer is present. */
  focusBox(): Promise<boolean>;
  /** Select-all + delete on the focused editor. */
  clearKeys(): Promise<void>;
  /** Is the composer now empty (or gone)? Must not false-positive. */
  isEmpty(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
};

/**
 * Empty the composer, and CONFIRM it. Returns true when the box is provably
 * empty (or absent) — i.e. when the next navigation cannot raise a dialog.
 *
 * Checks emptiness FIRST: the overwhelmingly common case after a successful
 * send is an already-clear box, and clicking into it would only re-focus a
 * composer we are about to navigate away from.
 *
 * Never throws — this runs on failure paths that have already decided the
 * draft's fate, and an exception here must not turn a handled reply failure
 * into an unhandled tick error.
 */
export async function runClearComposer(d: ClearComposerDeps, attempts = 2): Promise<boolean> {
  try {
    if (await d.isEmpty()) return true;
    for (let i = 0; i < attempts; i++) {
      if (!(await d.focusBox())) return true; // no composer on the page → nothing to clear
      await d.clearKeys();
      // The editors are React-controlled; the model update lands a frame or two
      // after the keystroke, so poll rather than reading once.
      for (let p = 0; p < 5; p++) {
        await d.sleep(120);
        if (await d.isEmpty()) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export type NavigateTabDeps = {
  /** Empty whatever composer this platform can leave dirty. Must not throw. */
  clearComposer(tabId: number): Promise<void>;
  /** The real navigation — `chrome.tabs.update(tabId, { url })`. */
  updateTab(tabId: number, url: string): Promise<void>;
  /**
   * Optional liveness check for callers whose navigation is conditional (a run
   * epoch, a STOP flag). Evaluated TWICE — before the clear and again before the
   * navigation — and a false answer abandons the hop.
   *
   * Both checks matter, for different reasons.
   *
   * The one before the CLEAR narrows the window: a caller that has ALREADY lost
   * interest by the time it gets here touches nothing at all, rather than wiping
   * a composer on the way to a hop it was never going to make.
   *
   * The one before the NAVIGATION catches the rest — a condition that flips
   * mid-clear — and stops a stale caller from moving the operator's tab. Note
   * what it cannot undo: by then the clear has already run, so a flip inside
   * that window still costs the draft. Nothing here can prevent that; the clear
   * has to precede the navigation, and the navigation is not knowable in
   * advance. The pre-check shrinks the exposure, it does not close it.
   */
  shouldProceed?(): Promise<boolean>;
};

/**
 * Navigate a run's tab, having FIRST emptied any composer still holding text.
 *
 * Clearing only after our own failed sends is not enough. The box can be dirty
 * for reasons this run never saw — a pre-fix build left text there, the operator
 * typed something himself, or a path nobody enumerated. Any of those turns the
 * next navigation into the `beforeunload` dialog described at the top of this
 * file, which blocks the renderer and wedges the run with no way to answer it
 * over CDP. Clearing at the navigation itself is the only placement that covers
 * every one of those cases, which is why this wrapper exists rather than another
 * call site remembering to clear first.
 *
 * Cheap in the normal case: `runClearComposer` checks emptiness before it
 * touches anything, so an empty or absent composer costs one read round trip
 * and no keystrokes.
 *
 * PROPAGATES a failed navigation, deliberately. A caller that types into the
 * page after navigating relies on the throw: swallowing it would let that caller
 * carry on believing it is on the target permalink and hunt for a composer on
 * whatever page the tab is actually showing — a not-found at best, a reply typed
 * under the WRONG post at worst. Best-effort callers add their own `.catch`.
 *
 * Note this discards whatever was in the box — including text the operator typed
 * by hand. That is the same outcome the navigation would have had anyway (the
 * dialog exists to warn about exactly that loss); it just happens without a
 * modal nobody is there to click.
 */
export function makeNavigateTab(d: NavigateTabDeps): (tabId: number, url: string) => Promise<void> {
  return async (tabId, url) => {
    // Nothing has been touched yet — the cheapest possible place to bail.
    if (d.shouldProceed && !(await d.shouldProceed())) return;
    // The clear is cleanup, the navigation is the job. A clearComposer that
    // rejects (a tab closed mid-run, a content script gone) must not block the
    // hop the caller actually asked for — that would turn a cosmetic stall into
    // a dead run. runClearComposer already swallows; this covers the rest.
    try {
      await d.clearComposer(tabId);
    } catch {
      // best-effort, by design
    }
    // Re-checked: the clear above is several round trips long, and a condition
    // that flipped inside it must not still move the operator's tab.
    if (d.shouldProceed && !(await d.shouldProceed())) return;
    await d.updateTab(tabId, url);
  };
}

/**
 * Is the composer holding the message we typed? Compared on the opening, with
 * ALL whitespace removed from both sides.
 *
 * Removed, not collapsed. `typeText` sends "\n" through Input.insertText and a
 * contenteditable turns it into a block boundary that contributes NO character
 * to textContent — so a body of "hi jess\nday 44…" is read back as
 * "hi jessday 44…". Collapsing whitespace to a single space normalises the two
 * sides in opposite directions and the comparison can never match: 98 of the
 * 113 DM drafts in the live DB carry a newline inside the first 40 characters,
 * so that spelling missed on essentially every real DM. Both the miss detection
 * and the ownership check for the unwind clear are built on this, and both were
 * inert because of it.
 *
 * A body shorter than the probe window is compared in full, which falls out of
 * the slice — an empty body matches nothing.
 */
export function sameDraft(boxText: string, body: string): boolean {
  const norm = (t: string) => t.replace(/\s+/g, "").toLowerCase();
  const a = norm(boxText);
  const b = norm(body);
  if (!b) return false;
  return a.includes(b.slice(0, 40));
}

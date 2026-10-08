// Submit-a-reply orchestration, extracted pure so the throw path is
// unit-testable. The service worker adapter (background/index.ts submitReply)
// injects the real effects (content-script locates, CDP clicks/chords, epoch
// staleness); tests inject fakes.
//
// THE invariant this module exists to protect: `dispatched` must survive a
// mid-gesture throw. A CDP send can reject AFTER the input already went out —
// the realistic case is the operator dismissing the chrome.debugger infobar
// mid-run, which detaches the debugger and makes the NEXT sendCommand reject
// (e.g. the click posts slowly, the posted-poll reads false, the first chord's
// rawKeyDown lands, then the keyUp/second-chord send throws). If that throw
// propagated, the caller's generic catch would treat the reply as a plain
// error, re-serve the draft, and re-post it — the exact duplicate-reply spam
// this lane prevents. So every throw inside the gesture section is caught and
// reported as `{ ok:false, detail:"gesture-error", dispatched }`, which the
// caller feeds into replyFailureDecision like any other failure: dispatched →
// drop-ambiguous (never retried), pre-dispatch → bounded retry.

// Outcome of a reply attempt. On failure, `detail` names the stage that broke
// ("box-not-found" / "submit-not-found" / "not-cleared" / "gesture-error" /
// "nav-or-type-error") so the DB skip row (x_activity.reason =
// `reply-failed:<detail>`) says WHY without a live DevTools session.
// `dispatched` records whether ANY submit gesture (tweetButton click or a
// ⌘/Ctrl+Enter chord) was actually fired: when true, an ok:false only means
// the composer never READ cleared — the post itself may have landed, so the
// caller must treat the draft as ambiguous and never retry it (see the
// replyFailureDecision policy at the call site).
export type ReplyResult = { ok: boolean; detail?: string; dispatched?: boolean };

export type SubmitLoc = {
  ok: boolean; x?: number; y?: number;
  rect?: { x: number; y: number; width: number; height: number };
};

/** Effects runSubmitReply needs. Every member may throw or reject — the
 * orchestrator classifies a throw by whether a gesture was dispatched. */
export type SubmitDeps = {
  /** true when the run that started this submit was stopped/superseded. */
  stale(): Promise<boolean>;
  /** Locate an ENABLED submit button; null/ok:false when not (yet) present. */
  locateSubmit(): Promise<SubmitLoc | null>;
  /** Trusted CDP click on the located submit. Counts as a dispatched gesture. */
  clickSubmit(loc: SubmitLoc): Promise<void>;
  /** Has the composer cleared (= reply landed)? Must NOT false-positive. */
  posted(): Promise<boolean>;
  /** Refocus the composer before the keyboard fallback. Best-effort. */
  refocusComposer(): Promise<void>;
  /** Fire a ⌘/Ctrl+Enter chord (mod 4 = Meta, 2 = Ctrl). Dispatched gesture. */
  chord(mod: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

/**
 * Submit the just-typed reply and CONFIRM it actually landed. Returns ok ONLY
 * when the composer clears — so a click that missed an off-viewport submit, or
 * a submit that never fired, is reported as a failure instead of a phantom
 * success that marks the draft sent with nothing posted.
 *
 * Order: (1) poll for an ENABLED submit — X keeps tweetButton(Inline) disabled
 * until the editor's model registers text — click it, confirm cleared;
 * (2) keyboard chord fallback (⌘/Ctrl+Enter, natively supported by X) that
 * works even when the button is off-viewport. The posted-check between chords
 * makes the fallback safe from double-posting: once anything posts and the box
 * clears, the next chord fires into an empty composer and no-ops.
 *
 * Never throws: any exception inside is reported as detail:"gesture-error"
 * with the dispatched flag preserved (see module header).
 */
export async function runSubmitReply(d: SubmitDeps, buttonPollMs = 12_000): Promise<ReplyResult> {
  let sawSubmit = false; // did an enabled submit button ever appear?
  let dispatched = false; // was ANY submit gesture (click or chord) fired? → ambiguous on failure
  try {
    // 1) Button path: poll for a clickable submit, click, verify cleared.
    const deadline = d.now() + buttonPollMs;
    while (d.now() < deadline) {
      if (await d.stale()) return { ok: false, detail: "stopped", dispatched };
      const submit = await d.locateSubmit().catch(() => null);
      if (submit?.ok && submit.x != null) {
        sawSubmit = true;
        dispatched = true; // set BEFORE the click: a mid-gesture throw is still ambiguous
        await d.clickSubmit(submit);
        // Poll for the post to settle (~3.2s) before concluding it missed — a
        // short window here reads a slow-landing post as a miss, and a retry
        // would re-type the whole reply (a duplicate if the first landed late).
        for (let i = 0; i < 8; i++) {
          await d.sleep(400);
          if (await d.posted()) return { ok: true };
        }
        break; // button was there but nothing cleared → keyboard fallback
      }
      await d.sleep(400); // submit not ready yet — X is still enabling it
    }

    // 2) Keyboard fallback: refocus the composer, then ⌘+Enter (macOS) / Ctrl+Enter.
    //    Verify after each so we never fire the second chord once the first posted.
    if (await d.stale()) return { ok: false, detail: "stopped", dispatched };
    // One more posted-check before any chord: if the click's post landed just
    // after the loop above gave up, chording now would re-submit needlessly.
    if (sawSubmit && (await d.posted())) return { ok: true };
    await d.refocusComposer();
    for (const mod of [4, 2]) { // 4 = Meta/⌘, 2 = Ctrl
      if (await d.stale()) return { ok: false, detail: "stopped", dispatched };
      dispatched = true; // the chord is a submit gesture too — X natively posts on ⌘/Ctrl+Enter
      await d.chord(mod);
      for (let i = 0; i < 3; i++) {
        await d.sleep(400);
        if (await d.posted()) return { ok: true };
      }
    }
    // Nothing landed. Name the stage so the DB skip row is diagnostic:
    //   submit-not-found → no enabled submit ever appeared in the poll (composer
    //                      state / testid drift); not-cleared → a submit was
    //                      clicked/chorded but the composer never cleared (post
    //                      rejected — e.g. a live action-block — or a decoy).
    // Both reach here with dispatched=true (the chord fallback fires either way),
    // so the caller treats them as ambiguous — dropped, never retried in-session.
    return { ok: false, detail: sawSubmit ? "not-cleared" : "submit-not-found", dispatched };
  } catch {
    // A gesture (or a check between gestures) threw. Whether the post landed is
    // UNKNOWN; only `dispatched` says whether anything could have gone out.
    // Never rethrow — a propagated throw would bypass replyFailureDecision and
    // let the generic tick catch re-serve (and re-post) a maybe-posted draft.
    return { ok: false, detail: "gesture-error", dispatched };
  }
}

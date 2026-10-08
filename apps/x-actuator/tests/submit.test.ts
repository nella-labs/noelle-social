import { describe, it, expect } from "vitest";
import { runSubmitReply, type SubmitDeps, type SubmitLoc } from "../src/background/submit.js";
import { replyFailureDecision } from "../src/background/replenish.js";

// Fake-deps builder with a virtual clock: sleep advances `t`, now reads it, so
// the 12s button poll and the settle polls run instantly and deterministically.
function deps(overrides: Partial<SubmitDeps> = {}) {
  let t = 0;
  const calls = { click: 0, chords: [] as number[], refocus: 0, posted: 0 };
  const loc: SubmitLoc = { ok: true, x: 10, y: 10, rect: { x: 8, y: 8, width: 40, height: 20 } };
  const d: SubmitDeps = {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    stale: async () => false,
    locateSubmit: async () => loc,
    clickSubmit: async () => { calls.click++; },
    posted: async () => { calls.posted++; return false; },
    refocusComposer: async () => { calls.refocus++; },
    chord: async (mod) => { calls.chords.push(mod); },
    ...overrides,
  };
  return { d, calls };
}

describe("runSubmitReply", () => {
  it("click → composer cleared → ok", async () => {
    const { d, calls } = deps({ posted: async () => true });
    expect(await runSubmitReply(d)).toEqual({ ok: true });
    expect(calls.click).toBe(1);
    expect(calls.chords).toEqual([]); // never chords once the click's post confirmed
  });

  it("no enabled submit ever + chords never confirm → submit-not-found, dispatched (chords fired)", async () => {
    const { d, calls } = deps({ locateSubmit: async () => null });
    expect(await runSubmitReply(d)).toEqual({ ok: false, detail: "submit-not-found", dispatched: true });
    expect(calls.click).toBe(0);
    expect(calls.chords).toEqual([4, 2]);
  });

  it("click not confirmed but the FIRST chord lands → ok, second chord never fired", async () => {
    let postedAfterChord = false;
    const { d, calls } = deps({
      chord: async (mod) => { calls.chords.push(mod); postedAfterChord = true; },
      posted: async () => postedAfterChord,
    });
    expect(await runSubmitReply(d)).toEqual({ ok: true });
    expect(calls.chords).toEqual([4]);
  });

  it("late-landing click is caught by the pre-chord re-check → ok with zero chords", async () => {
    let n = 0;
    // false for the 8 settle polls, true from the pre-chord re-check on
    const { d, calls } = deps({ posted: async () => ++n > 8 });
    expect(await runSubmitReply(d)).toEqual({ ok: true });
    expect(calls.click).toBe(1);
    expect(calls.chords).toEqual([]);
  });

  // ── THE throw-path regression (round-3 blocker) ──────────────────────────
  // A CDP send can reject AFTER the gesture went out — e.g. the operator
  // dismisses the chrome.debugger infobar mid-run, detaching the debugger so
  // the next sendCommand rejects. The result must carry dispatched:true so the
  // caller's replyFailureDecision drops the draft as ambiguous instead of the
  // throw escaping to the generic tick catch and the draft being re-served —
  // and the SAME reply re-posted.

  it("clickSubmit throws mid-gesture → gesture-error with dispatched:true (never throws)", async () => {
    const { d } = deps({ clickSubmit: async () => { throw new Error("Debugger is not attached"); } });
    const res = await runSubmitReply(d);
    expect(res).toEqual({ ok: false, detail: "gesture-error", dispatched: true });
    // …and the policy turns that into drop-ambiguous, not a retry:
    expect(replyFailureDecision(res.dispatched === true, 0)).toEqual({ plan: "drop-ambiguous" });
  });

  it("the reviewer's exact race: click posts slowly, first chord's rawKeyDown lands, next CDP send throws", async () => {
    let chords = 0;
    const { d } = deps({
      posted: async () => false, // replyPosted polls false the whole way
      chord: async () => {
        chords++;
        if (chords === 2) throw new Error("target closed"); // detach between chords
      },
    });
    const res = await runSubmitReply(d);
    expect(res).toEqual({ ok: false, detail: "gesture-error", dispatched: true });
    expect(replyFailureDecision(res.dispatched === true, 0)).toEqual({ plan: "drop-ambiguous" });
  });

  it("first chord itself throws (after a clean no-button path) → still dispatched:true", async () => {
    const { d } = deps({
      locateSubmit: async () => null,
      chord: async () => { throw new Error("detached"); },
    });
    expect(await runSubmitReply(d)).toEqual({ ok: false, detail: "gesture-error", dispatched: true });
  });

  it("a posted() check that throws AFTER the click is still ambiguous", async () => {
    const { d } = deps({ posted: async () => { throw new Error("tab gone"); } });
    // clickSubmit succeeded → dispatched, then the settle poll's posted() throws
    expect(await runSubmitReply(d)).toEqual({ ok: false, detail: "gesture-error", dispatched: true });
  });

  it("a PRE-dispatch throw reports dispatched:false → bounded retry, not ambiguous", async () => {
    const { d, calls } = deps({ stale: async () => { throw new Error("storage exploded"); } });
    const res = await runSubmitReply(d);
    expect(res).toEqual({ ok: false, detail: "gesture-error", dispatched: false });
    expect(calls.click).toBe(0);
    expect(calls.chords).toEqual([]);
    expect(replyFailureDecision(res.dispatched === true, 0)).toEqual({ plan: "retry-back", tries: 1 });
  });

  it("stale before anything fires → stopped, dispatched:false", async () => {
    const { d } = deps({ stale: async () => true });
    expect(await runSubmitReply(d)).toEqual({ ok: false, detail: "stopped", dispatched: false });
  });

  it("button clicked then run superseded → stopped but dispatched:true survives", async () => {
    let staleCalls = 0;
    const { d } = deps({ stale: async () => ++staleCalls > 1 }); // fresh for the click, stale at the fallback gate
    expect(await runSubmitReply(d)).toEqual({ ok: false, detail: "stopped", dispatched: true });
  });

  it("refocusComposer throwing after a dispatched click is still ambiguous", async () => {
    const { d } = deps({ refocusComposer: async () => { throw new Error("no box"); } });
    expect(await runSubmitReply(d)).toEqual({ ok: false, detail: "gesture-error", dispatched: true });
  });
});

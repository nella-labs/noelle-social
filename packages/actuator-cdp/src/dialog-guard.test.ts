import { describe, it, expect, vi } from "vitest";
import {
  createDialogGuard,
  defaultReactionMs,
  dialogShouldAccept,
  type DebuggerEventListener,
  type DialogGuardDeps,
} from "./dialog-guard.js";

/** Harness: captures every CDP send and lets a test fire debugger events. */
function harness(overrides: Partial<DialogGuardDeps> = {}) {
  const sends: { tabId: number; method: string; params?: object }[] = [];
  const slept: number[] = [];
  let fire: DebuggerEventListener = () => {};
  const logs: { level: string; msg: string; meta?: Record<string, unknown> }[] = [];
  const deps: DialogGuardDeps = {
    // Real time would make every dialog test wait ~1s; record and skip it.
    reactionMs: () => 700,
    sleep: async (ms) => {
      slept.push(ms);
    },
    send: async (tabId, method, params) => {
      sends.push(params === undefined ? { tabId, method } : { tabId, method, params });
      return undefined;
    },
    addEventListener: (cb) => {
      fire = cb;
    },
    log: (level, msg, meta) => {
      logs.push(meta === undefined ? { level, msg } : { level, msg, meta });
    },
    ...overrides,
  };
  const guard = createDialogGuard(deps);
  return { guard, sends, slept, logs, fire: (...a: Parameters<DebuggerEventListener>) => fire(...a) };
}

const opening = (type: string, message = "") => ({
  url: "https://x.com/i/status/1",
  message,
  type,
  hasBrowserHandler: false,
});

describe("dialogShouldAccept", () => {
  // beforeunload is the one this whole module exists for: the actuator ASKED to
  // navigate, so "Leave" is the outcome that matches intent. Dismissing it would
  // cancel the navigation and strand the run on the previous page.
  it("accepts beforeunload so the actuator's own navigation goes through", () => {
    expect(dialogShouldAccept("beforeunload")).toBe(true);
  });

  // alert has only an OK button — accepting is the only way to close it.
  it("accepts alert", () => {
    expect(dialogShouldAccept("alert")).toBe(true);
  });

  // A confirm/prompt we did not author could be anything ("Delete this post?").
  // Closing it must never affirm it.
  it("dismisses confirm and prompt rather than affirming an unknown question", () => {
    expect(dialogShouldAccept("confirm")).toBe(false);
    expect(dialogShouldAccept("prompt")).toBe(false);
  });

  it("dismisses an unrecognised dialog type", () => {
    expect(dialogShouldAccept("somethingnew")).toBe(false);
  });
});

describe("defaultReactionMs", () => {
  // A 0ms answer is its own bot tell: a page can call confirm() and time the
  // round trip, and no human reads "Leave site?" and clicks instantly.
  it("always draws a human-plausible read-and-click delay", () => {
    for (let i = 0; i < 500; i++) {
      const ms = defaultReactionMs();
      expect(ms).toBeGreaterThanOrEqual(480);
      expect(ms).toBeLessThanOrEqual(1400);
    }
  });

  it("varies (a constant delay would be its own fingerprint)", () => {
    const draws = new Set(Array.from({ length: 50 }, () => defaultReactionMs()));
    expect(draws.size).toBeGreaterThan(40);
  });
});

describe("createDialogGuard", () => {
  it("arming a tab enables the Page domain (without it no dialog event ever arrives)", async () => {
    const { guard, sends } = harness();
    await guard.arm(7);
    expect(sends).toEqual([{ tabId: 7, method: "Page.enable" }]);
  });

  // CDP domain state is per debugger SESSION. Dismissing the "Extension is
  // debugging this browser" infobar drops the session, and the re-attach that
  // follows starts a fresh one with Page disabled again. Short-circuiting a
  // repeat arm would leave the guard silently dead on exactly the tab that just
  // proved it needs one.
  it("re-arming a tab re-enables Page (a re-attach resets domain state)", async () => {
    const { guard, sends } = harness();
    await guard.arm(7);
    await guard.arm(7);
    expect(sends.filter((s) => s.method === "Page.enable")).toHaveLength(2);
  });

  it("keeps answering dialogs after a detach/re-attach cycle", async () => {
    const { guard, sends, fire } = harness();
    await guard.arm(7);
    await guard.disarm(7);
    await guard.arm(7); // the re-attach
    sends.length = 0;
    fire({ tabId: 7 }, "Page.javascriptDialogOpening", opening("beforeunload"));
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]?.method).toBe("Page.handleJavaScriptDialog");
  });

  // A swallowed Page.enable failure means no dialog event ever arrives and the
  // wedge is back — invisible unless it says so.
  it("warns when Page.enable fails instead of failing silently", async () => {
    const send = vi.fn(async (_tabId: number, method: string) => {
      if (method === "Page.enable") throw new Error("Debugger is not attached to the tab with id: 7.");
      return undefined;
    });
    const { guard, logs } = harness({ send });
    await guard.arm(7);
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  // Cdp.attach (and so arm) runs EVERY tick. A dead tab warning every tick
  // would flood the bridge sink and bury the one line that mattered.
  it("warns only once while a tab keeps failing to arm", async () => {
    const send = vi.fn(async (_tabId: number, method: string) => {
      if (method === "Page.enable") throw new Error("No tab with given id 7.");
      return undefined;
    });
    const { guard, logs } = harness({ send });
    for (let i = 0; i < 10; i++) await guard.arm(7);
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("warns again after a tab recovers and then fails once more", async () => {
    let fail = true;
    const send = vi.fn(async (_tabId: number, method: string) => {
      if (method === "Page.enable" && fail) throw new Error("No tab with given id 7.");
      return undefined;
    });
    const { guard, logs } = harness({ send });
    await guard.arm(7); // warn #1
    fail = false;
    await guard.arm(7); // recovered
    fail = true;
    await guard.arm(7); // warn #2 — news again
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  // A tab whose enable never landed has no Page domain to disable, and the
  // detach right behind it would reject anyway.
  it("does not send Page.disable for a tab that never enabled", async () => {
    // Records into its OWN array: an overridden `send` bypasses the harness
    // recorder, so asserting on `sends` here would pass vacuously.
    const seen: string[] = [];
    const send = vi.fn(async (_tabId: number, method: string) => {
      seen.push(method);
      if (method === "Page.enable") throw new Error("No tab with given id 7.");
      return undefined;
    });
    const { guard } = harness({ send });
    await guard.arm(7);
    await guard.disarm(7);
    expect(seen).toEqual(["Page.enable"]); // the enable attempt, and nothing after
  });

  // THE regression: a beforeunload dialog on a debugger-driven tab blocks the
  // renderer, so every later Input.* hangs and the run wedges until a human
  // clicks the button. The guard must close it unprompted.
  it("closes a beforeunload dialog by accepting it", async () => {
    const { guard, sends, fire } = harness();
    await guard.arm(7);
    sends.length = 0;
    fire({ tabId: 7 }, "Page.javascriptDialogOpening", opening("beforeunload", "Changes you made may not be saved."));
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      tabId: 7,
      method: "Page.handleJavaScriptDialog",
      params: { accept: true },
    });
  });

  it("waits a reaction delay before answering, never 0ms", async () => {
    const { guard, slept, fire } = harness();
    await guard.arm(7);
    fire({ tabId: 7 }, "Page.javascriptDialogOpening", opening("beforeunload"));
    await vi.waitFor(() => expect(slept).toEqual([700]));
  });

  it("closes a confirm dialog by dismissing it", async () => {
    const { guard, sends, fire } = harness();
    await guard.arm(7);
    sends.length = 0;
    fire({ tabId: 7 }, "Page.javascriptDialogOpening", opening("confirm", "Discard post?"));
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]?.params).toEqual({ accept: false });
  });

  // The guard listens on ONE global chrome.debugger.onEvent, so it sees events
  // for every tab this extension attached. Handling all of them (not just a
  // bookkeeping set) is deliberate: an unhandled dialog is a wedged run.
  it("handles a dialog on a tab it never armed", async () => {
    const { guard, sends, fire } = harness();
    void guard;
    fire({ tabId: 99 }, "Page.javascriptDialogOpening", opening("beforeunload"));
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]?.tabId).toBe(99);
  });

  it("ignores every other debugger event", async () => {
    const { guard, sends, fire } = harness();
    await guard.arm(7);
    sends.length = 0;
    fire({ tabId: 7 }, "Page.frameNavigated", { frame: {} });
    fire({ tabId: 7 }, "Page.loadEventFired", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(sends).toEqual([]);
  });

  it("ignores an event with no tabId (target-scoped debuggee)", async () => {
    const { guard, sends, fire } = harness();
    void guard;
    fire({}, "Page.javascriptDialogOpening", opening("beforeunload"));
    await new Promise((r) => setTimeout(r, 0));
    expect(sends).toEqual([]);
  });

  // A dialog on a tab that closed mid-run makes handleJavaScriptDialog reject.
  // The listener is fired by Chrome, so an escaping rejection is an unhandled
  // one — it must be swallowed.
  it("swallows a rejecting handleJavaScriptDialog instead of throwing", async () => {
    const send = vi.fn(async (_tabId: number, method: string) => {
      if (method === "Page.handleJavaScriptDialog") throw new Error("No tab with given id 7.");
      return undefined;
    });
    const { guard, logs, fire } = harness({ send });
    await guard.arm(7);
    expect(() => fire({ tabId: 7 }, "Page.javascriptDialogOpening", opening("beforeunload"))).not.toThrow();
    await vi.waitFor(() => expect(logs.some((l) => l.level === "warn")).toBe(true));
  });

  // Page.enable is best-effort: a tab that dies between attach and arm must not
  // take the run down with it.
  it("swallows a rejecting Page.enable", async () => {
    const send = vi.fn(async () => {
      throw new Error("Debugger is not attached to the tab with id: 7.");
    });
    const { guard } = harness({ send });
    await expect(guard.arm(7)).resolves.toBeUndefined();
  });

  it("disarming disables the Page domain and allows a later re-arm", async () => {
    const { guard, sends } = harness();
    await guard.arm(7);
    await guard.disarm(7);
    await guard.arm(7);
    expect(sends.map((s) => s.method)).toEqual(["Page.enable", "Page.disable", "Page.enable"]);
  });

  // The dialog is invisible in the DB and DevTools can't be open during a run
  // (chrome.debugger holds the tab), so this log line is the only evidence that
  // the wall was hit and cleared.
  it("logs each dialog it closed so a wedge leaves a trace", async () => {
    const { guard, logs, fire } = harness();
    await guard.arm(7);
    fire({ tabId: 7 }, "Page.javascriptDialogOpening", opening("beforeunload", "Changes you made may not be saved."));
    await vi.waitFor(() => expect(logs.filter((l) => l.level === "info")).toHaveLength(1));
    expect(logs[0]?.meta).toEqual({
      tabId: 7,
      type: "beforeunload",
      accept: true,
      message: "Changes you made may not be saved.",
    });
  });

  // A 120-char cap: the sink buffers these, and an adversarial page could set a
  // multi-megabyte dialog message.
  it("truncates a huge dialog message before logging it", async () => {
    const { guard, logs, fire } = harness();
    await guard.arm(7);
    fire({ tabId: 7 }, "Page.javascriptDialogOpening", opening("beforeunload", "x".repeat(5000)));
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect((logs[0]?.meta as { message: string }).message).toHaveLength(120);
  });
});

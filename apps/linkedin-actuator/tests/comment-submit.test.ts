// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunState } from "../src/background/state.js";
const seams = vi.hoisted(() => ({
  fetchQueue: vi.fn(),
  claimComment: vi.fn(),
  markSent: vi.fn(),
  markSkipped: vi.fn(),
  logActivity: vi.fn(),
  enableSend: vi.fn(),
  ackIntent: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  detachAll: vi.fn(),
  moveAndClick: vi.fn(),
  typeText: vi.fn(),
  pressSubmitChord: vi.fn(),
  clearFocusedEditor: vi.fn(),
  wheel: vi.fn(),
}));
vi.mock("../src/lib/api.js", () => ({
  ActuatorApi: class {
    fetchQueue = seams.fetchQueue;
    claimComment = seams.claimComment;
    markSent = seams.markSent;
    markSkipped = seams.markSkipped;
    logActivity = seams.logActivity;
    enableSend = seams.enableSend;
    ackIntent = seams.ackIntent;
  },
}));
vi.mock("../src/background/cdp.js", () => ({
  Cdp: class {
    attach = seams.attach;
    detach = seams.detach;
    detachAll = seams.detachAll;
    moveAndClick = seams.moveAndClick;
    typeText = seams.typeText;
    pressSubmitChord = seams.pressSubmitChord;
    clearFocusedEditor = seams.clearFocusedEditor;
    wheel = seams.wheel;
  },
}));
vi.mock("../src/content/panel.js", () => ({ mountPanel: vi.fn() }));
vi.mock("../src/lib/cancel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    abortableSleep: async (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
      await Promise.resolve();
    },
  };
});
type Stored = Record<string, unknown>;
type Response = { ok: boolean; error?: string; observed?: Record<string, unknown> };
type Handler = (
  msg: { cmd: string; [key: string]: unknown },
  sender: unknown,
  reply: (value: Response) => void,
) => boolean;
const body = "The approved reply body";
const target =
  '<article data-id="urn:li:comment:(ugcPost:123,111)"><button aria-label="Reply" data-x="10">Reply</button></article>';
const replyBox =
  '<div componentkey="commentBox-target"><div contenteditable="true" role="textbox" data-x="20" id="editor"><span data-type="mention">Ann Smith</span><span id="body"></span></div><section id="commentButtonSection-target"><button data-x="30">Reply</button></section></div>';
const postBox =
  '<div class="comments-comment-box"><div contenteditable="true" role="textbox" data-x="20" id="editor"></div><button type="submit" data-x="30">Comment</button></div>';
function storage(values: Stored) {
  return {
    get: vi.fn(async (keys: string | string[]) =>
      Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys])
          .filter((key) => key in values)
          .map((key) => [key, structuredClone(values[key])]),
      ),
    ),
    set: vi.fn(async (patch: Stored) => {
      Object.assign(values, structuredClone(patch));
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }),
  };
}
type Mode =
  | "thread-still"
  | "thread-clear"
  | "thread-gone"
  | "thread-read-error"
  | "thread-unrelated"
  | "post-click"
  | "post-meta"
  | "post-ctrl"
  | "post-lost-box"
  | "post-read-error"
  | "thread-anchor-missing"
  | "thread-malformed-read"
  | "post-meta-lost"
  | "post-other-body";
async function boot(mode: Mode, options: { stopBeforeClaim?: boolean } = {}) {
  const thread = mode.startsWith("thread");
  let clicked = false;
  let lost = false;
  let focusedX = 20;
  document.body.innerHTML = thread ? target : postBox;
  const localValues: Stored = {
    "actuator.config": {
      apiBaseUrl: "https://inert.example.test",
      token: "inert",
      instanceId: "instance",
      caps: { likes: 1, comments: 1, dms: 0 },
      autonomous: false,
    },
    "actuator.automationStartMs": Date.now() - 90 * 86400000,
  };
  const sessionValues: Stored = {
    "actuator.epoch": 7,
    "actuator.runstate": {
      sessionId: "saved",
      epoch: 7,
      status: "running",
      startMs: Date.now() - 60000,
      windowHours: 2,
      tabId: 9,
      actions: [
        { kind: "comment", atMs: Date.now(), executed: false },
        { kind: "like", atMs: Date.now() + 3600000, executed: false },
      ],
      targets: { likes: 1, comments: 1, dms: 0 },
      done: { likes: 0, comments: 0, dms: 0 },
      commentPool: [
        {
          approvalId: "approval",
          draftId: "draft",
          body,
          url: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
          ...(thread ? { commentUrn: "111", commentAuthorName: "Ann Smith" } : {}),
        },
      ],
      dmPool: [],
      doneDraftIds: [],
      lastPollMs: Date.now(),
      persona: { wpm: 200 },
      warmupSuppressMs: 0,
    },
  };
  const listeners: Handler[] = [];
  const addListener = vi.fn();
  const contentCommand = (msg: Parameters<Handler>[0]) =>
    new Promise<Response>((resolve) => {
      expect(listeners[0]!(msg, {}, resolve)).toBe(true);
    });
  const chrome = {
    storage: { local: storage(localValues), session: storage(sessionValues) },
    runtime: {
      onStartup: { addListener },
      onInstalled: { addListener },
      onMessage: { addListener: (handler: Handler) => listeners.push(handler) },
    },
    alarms: {
      create: vi.fn(async () => {}),
      clear: vi.fn(async () => true),
      onAlarm: { addListener },
    },
    tabs: {
      query: vi.fn(async () => [
        { id: 9, url: "https://www.linkedin.com/feed/", status: "complete" },
      ]),
      get: vi.fn(async () => ({
        id: 9,
        url: "https://www.linkedin.com/feed/",
        status: "complete",
      })),
      update: vi.fn(async () => {}),
      onCreated: { addListener },
      onUpdated: { addListener },
      sendMessage: vi.fn(async (_id: number, msg: Parameters<Handler>[0]) => {
        if (
          clicked &&
          ((mode === "thread-read-error" && msg.cmd === "readReplyComposer") ||
            (mode === "post-read-error" && msg.cmd === "readCommentBox"))
        )
          throw new Error("inert dropped content port");
        if (clicked && mode === "post-meta-lost" && msg.cmd === "readCommentBox")
          throw new Error("inert dropped post read");
        if (clicked && mode === "thread-malformed-read" && msg.cmd === "readReplyComposer")
          return { ok: false, observed: { present: false, empty: true } };
        const result = await contentCommand(msg);
        if (options.stopBeforeClaim && msg.cmd === "locateReplySubmit")
          await new Promise((resolve) => listeners[1]!({ cmd: "stopRun" }, {}, resolve));
        return result;
      }),
    },
  };
  vi.stubGlobal("chrome", chrome);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network forbidden");
    }),
  );
  seams.moveAndClick.mockImplementation(async (_id: number, rect: { x: number }) => {
    focusedX = rect.x;
    if (rect.x === 10) {
      document.querySelector("article")!.insertAdjacentHTML("beforeend", replyBox);
      return;
    }
    if (rect.x === 30) {
      clicked = true;
      if (mode === "thread-clear") {
        document.getElementById("body")!.textContent = "";
      }
      if (mode === "thread-gone") {
        document.querySelector('[componentkey="commentBox-target"]')!.remove();
      }
      if (mode === "thread-anchor-missing") document.querySelector("article")!.remove();
      if (mode === "post-click") {
        document.getElementById("editor")!.textContent = "";
      }
    }
  });
  seams.typeText.mockImplementation(async (_id: number, text: string) => {
    document.getElementById(thread ? "body" : "editor")!.textContent = text;
    if (mode === "thread-unrelated")
      document.body.insertAdjacentHTML(
        "afterbegin",
        '<div class="comments-comment-box"><div contenteditable="true" role="textbox" data-x="200" id="unrelated">unrelated comment draft</div></div><div class="msg-form"><div contenteditable="true" role="textbox" data-x="300">private operator draft</div></div>',
      );
    if (
      ["post-meta", "post-ctrl", "post-lost-box", "post-meta-lost", "post-other-body"].includes(
        mode,
      )
    )
      document.querySelector('button[type="submit"]')!.remove();
    if (mode === "post-other-body")
      document.getElementById("editor")!.textContent = "An unrelated operator comment";
  });
  seams.pressSubmitChord.mockImplementation(async (_id: number, mod: number) => {
    clicked = true;
    if (mode === "post-meta-lost" && mod === 4)
      document.body.innerHTML =
        '<div class="msg-form"><div contenteditable="true" role="textbox">private operator draft</div></div>';
    if ((mode === "post-meta" && mod === 4) || (mode === "post-ctrl" && mod === 2))
      document.getElementById("editor")!.textContent = "";
  });
  seams.clearFocusedEditor.mockImplementation(async () => {
    const editor = document.querySelector(`[contenteditable="true"][data-x="${focusedX}"]`);
    const node = editor?.querySelector("#body") ?? editor;
    if (node) node.textContent = "";
  });
  if (mode === "post-lost-box") {
    const original = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = vi.fn(async (id: number, msg: Parameters<Handler>[0]) => {
      if (msg.cmd === "locateCommentSubmit" && !lost) {
        lost = true;
        document.body.innerHTML =
          '<div class="msg-form"><div contenteditable="true" role="textbox" data-x="200">private operator draft</div></div>';
      }
      return original(id, msg);
    });
  }
  vi.resetModules();
  const content = await import("../src/content/index.js");
  content.initContent();
  await import("../src/background/index.js");
  expect(listeners).toHaveLength(2);
  const tick = () =>
    new Promise<Response>((resolve) => {
      expect(listeners[1]!({ cmd: "tick" }, {}, resolve)).toBe(true);
    });
  return {
    tick,
    contentCommand,
    sessionValues,
    chrome,
    snapshot: () => structuredClone(sessionValues["actuator.runstate"]) as RunState,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const x = Number(this.getAttribute("data-x") ?? 1);
    return {
      x,
      y: 20,
      width: 40,
      height: 20,
      top: 20,
      left: x,
      right: x + 40,
      bottom: 40,
      toJSON: () => ({}),
    } as DOMRect;
  });
  seams.fetchQueue.mockResolvedValue({ comments: [{ approval_id: "approval" }], dms: [] });
  seams.claimComment.mockResolvedValue({ claimed: true });
  for (const name of [
    "markSent",
    "markSkipped",
    "logActivity",
    "enableSend",
    "ackIntent",
    "attach",
    "detach",
    "detachAll",
    "wheel",
  ] as const)
    seams[name].mockResolvedValue(undefined);
});
afterEach(async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
function observation(mode: Mode, h: Awaited<ReturnType<typeof boot>>) {
  const value = {
    mode,
    done: h.snapshot().done,
    doneDraftIds: h.snapshot().doneDraftIds,
    markSent: seams.markSent.mock.calls,
    claim: seams.claimComment.mock.calls,
    chords: seams.pressSubmitChord.mock.calls.map((args) => args[1]),
    events: seams.logActivity.mock.calls,
    visibleText: document.getElementById("editor")?.textContent ?? null,
  };
  return value;
}
describe("actual registered worker tick composed with current content handler", () => {
  it.each(["thread-clear", "thread-gone"] as const)(
    "healthy %s confirms one threaded reply",
    async (mode) => {
      const h = await boot(mode);
      expect(await h.tick()).toEqual({ ok: true });
      const seen = observation(mode, h);
      expect(seen.markSent).toHaveLength(1);
      expect(seen.done.comments).toBe(1);
      expect(seen.claim).toHaveLength(1);
      expect(seen.chords).toEqual([]);
    },
  );
  it.each(["thread-still", "thread-read-error"] as const)(
    "%s cannot falsely mark the unchanged or unreadable reply sent",
    async (mode) => {
      const h = await boot(mode);
      expect(await h.tick()).toEqual({ ok: true });
      const seen = observation(mode, h);
      expect(seen.claim).toHaveLength(1);
      expect(seen.markSent).toHaveLength(0);
      expect(seen.done.comments).toBe(0);
      expect(seen.doneDraftIds).toContain("draft");
      expect(seen.chords).toEqual([]);
    },
  );
  it.each([
    ["post-click", []],
    ["post-meta", [4]],
    ["post-ctrl", [4, 2]],
  ] as const)("healthy %s stops fallback after measured clearing", async (mode, chords) => {
    const h = await boot(mode);
    expect(await h.tick()).toEqual({ ok: true });
    const seen = observation(mode, h);
    expect(seen.done.comments).toBe(1);
    expect(seen.markSent).toHaveLength(1);
    expect(seen.claim).toHaveLength(1);
    expect(seen.chords).toEqual(chords);
  });
  it("post-lost-box sends no Meta/CtrlEnter into a remaining private message editor", async () => {
    const h = await boot("post-lost-box");
    expect(await h.tick()).toEqual({ ok: true });
    const seen = observation("post-lost-box", h);
    expect(seen.chords).toEqual([]);
    expect(seen.markSent).toHaveLength(0);
    expect(document.querySelector(".msg-form")!.textContent).toBe("private operator draft");
  });
  it("post-read-error remains unconfirmed without false success", async () => {
    const h = await boot("post-read-error");
    expect(await h.tick()).toEqual({ ok: true });
    const seen = observation("post-read-error", h);
    expect(seen.markSent).toHaveLength(0);
    expect(seen.done.comments).toBe(0);
    expect(seen.doneDraftIds).toContain("draft");
  });

  it.each([
    "thread-still",
    "thread-read-error",
    "thread-anchor-missing",
    "thread-malformed-read",
  ] as const)("%s retains the claim without a second tick dispatch", async (mode) => {
    const h = await boot(mode);
    expect(await h.tick()).toEqual({ ok: true });
    expect(h.snapshot().done.comments).toBe(0);
    expect(seams.markSent).not.toHaveBeenCalled();
    expect(h.snapshot().doneDraftIds).toContain("draft");
    expect(h.snapshot().commentPool).toEqual([]);
    const clicks = seams.moveAndClick.mock.calls.filter((call) => call[1].x === 30).length;
    expect(clicks).toBe(1);
    expect(seams.claimComment).toHaveBeenCalledTimes(1);
    expect(await h.tick()).toEqual({ ok: true });
    expect(seams.claimComment).toHaveBeenCalledTimes(1);
    expect(seams.moveAndClick.mock.calls.filter((call) => call[1].x === 30)).toHaveLength(1);
    expect(seams.markSent).not.toHaveBeenCalled();
  });
  it("a denied claim dispatches no submit and records no sent count", async () => {
    seams.claimComment.mockResolvedValue({ claimed: false });
    const h = await boot("thread-still");
    expect(await h.tick()).toEqual({ ok: true });
    expect(h.snapshot().done.comments).toBe(0);
    expect(seams.moveAndClick.mock.calls.filter((call) => call[1].x === 30)).toEqual([]);
    expect(seams.markSent).not.toHaveBeenCalled();
    expect(seams.pressSubmitChord).not.toHaveBeenCalled();
  });
  it("failed threaded cleanup clears only the named reply and preserves other drafts", async () => {
    const h = await boot("thread-unrelated");
    expect(await h.tick()).toEqual({ ok: true });
    expect(document.getElementById("body")!.textContent).toBe("");
    expect(document.getElementById("unrelated")!.textContent).toBe("unrelated comment draft");
    expect(document.querySelector(".msg-form")!.textContent).toBe("private operator draft");
    expect(seams.clearFocusedEditor).toHaveBeenCalledTimes(1);
    expect(seams.markSent).not.toHaveBeenCalled();
    expect(h.snapshot().done.comments).toBe(0);
  });
  it("STOP before the reply claim prevents the browser submit", async () => {
    const h = await boot("thread-still", { stopBeforeClaim: true });
    expect(await h.tick()).toEqual({ ok: true });
    expect(h.snapshot().status).toBe("stopped");
    expect(seams.markSent).not.toHaveBeenCalled();
    expect(seams.claimComment).not.toHaveBeenCalled();
    expect(seams.moveAndClick.mock.calls.filter((call) => call[1].x === 30)).toEqual([]);
  });
  it("a lost editor after Meta cannot receive the Ctrl fallback", async () => {
    const h = await boot("post-meta-lost");
    expect(await h.tick()).toEqual({ ok: true });
    expect(seams.pressSubmitChord.mock.calls.map((call) => call[1])).toEqual([4]);
    expect(seams.markSent).not.toHaveBeenCalled();
    expect(h.snapshot().done.comments).toBe(0);
    expect(document.querySelector(".msg-form")!.textContent).toBe("private operator draft");
  });
  it("a different current body receives no fallback chord", async () => {
    const h = await boot("post-other-body");
    expect(await h.tick()).toEqual({ ok: true });
    expect(seams.pressSubmitChord).not.toHaveBeenCalled();
    expect(seams.claimComment).not.toHaveBeenCalled();
    expect(seams.markSent).not.toHaveBeenCalled();
  });
});

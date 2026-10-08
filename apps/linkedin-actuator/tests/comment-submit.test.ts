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

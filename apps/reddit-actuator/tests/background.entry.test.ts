// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyReplyCleared, readReplyBox } from "../src/content/locators.js";
import type { RunState } from "../src/background/state.ts";

type Mode = "dirty" | "absent" | "empty" | "post-challenge" | "read-error" | "submit-missing" | "click-throw" | "late" | "removed";
const f = vi.hoisted(() => ({
  now: Date.parse("2026-10-06T12:00:00Z"),
  mode: "empty" as Mode, submits: 0, probes: 0, typed: 0,
  sentFailure: false, activityFailure: false, claimed: false, comment: false,
  state: null as RunState | null,
  onMessage: null as null | ((message: { cmd: string }, sender: unknown, reply: (result: unknown) => void) => unknown),
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  order: [] as string[],
  observations: [] as unknown[],
}));

vi.mock("../src/background/state.ts", async (original) => ({
  ...await original(),
  loadState: async () => f.state,
  currentEpoch: async () => f.state?.epoch ?? 1,
  bumpEpoch: async () => 2,
  saveState: async (state: RunState) => { f.state = state; f.order.push("persist"); },
  saveIfCurrent: async (state: RunState) => { f.state = state; f.order.push("persist"); return true; },
}));
vi.mock("../src/lib/cancel.ts", async (original) => ({
  ...await original(),
  abortableSleep: async (ms: number, signal: AbortSignal) => { if (!signal.aborted) f.now += ms; },
}));
vi.mock("../src/lib/bridge-sink.ts", () => ({
  bridgePulse: vi.fn(), sinkLog: vi.fn(),
}));
vi.mock("../src/background/cdp.ts", () => ({
  Cdp: class {
    async attach() {}
    async detachAll() {}
    async moveAndClick(_tab: number, rect: { x: number }) {
      if (rect.x !== 30) return;
      f.submits++;
      f.order.push("submit");
      if (f.mode === "absent") document.body.innerHTML = "<main>temporary blank thread</main>";
      if (f.mode === "empty" || f.mode === "post-challenge") document.body.innerHTML = '<div contenteditable="true" name="body" role="textbox"></div>';
      if (f.mode === "click-throw" && f.submits === 1) throw new Error("detached after simulated mouse release");
    }
    async typeText(_tab: number, body: string) {
      f.typed++;
      document.body.innerHTML = '<div contenteditable="true" name="body" role="textbox"></div>';
      document.body.firstElementChild!.textContent = body;
    }
    async clearFocusedEditor() { document.body.innerHTML = '<div contenteditable="true" name="body" role="textbox"></div>'; }
  },
}));

const ids = {
  approval: "11111111-1111-4111-8111-111111111111",
  draft: "22222222-2222-4222-8222-222222222222",
  lead: "33333333-3333-4333-8333-333333333333",
  instance: "44444444-4444-4444-8444-444444444444",
  session: "55555555-5555-4555-8555-555555555555",
};
const url = "https://www.reddit.com/r/saas/comments/abc123/title/";
const item = () => ({ approvalId: ids.approval, draftId: ids.draft, body: "A grounded reply.", url, targetType: "post" as const });
const cfg = { apiBaseUrl: "http://127.0.0.1:9/inert", token: "inert", instanceId: ids.instance, caps: { comments: 8, likes: 0, dms: 0 }, preferWatchlistRatio: 0, deepNightTaper: false, autonomous: false, upvotesEnabled: false, bridgeSink: false };
const locate = (x: number) => ({ ok: true, x: x + 1, y: 1, rect: { x, y: 0, width: 10, height: 10 }, observed: { via: "composer1", text: "Comment", type: "submit" } });
function makeState(): RunState {
  return {
    sessionId: ids.session, epoch: 1, startMs: f.now - 60_000, windowHours: 8,
    actions: [{ kind: "comment", atMs: f.now - 1, executed: false }, { kind: "comment", atMs: f.now + 7 * 3600_000, executed: false }],
    targets: { likes: 0, comments: 2, dms: 0 }, done: { likes: 0, comments: 0, dms: 0 },
    commentPool: [item()], dmPool: [], doneDraftIds: [], lastPollMs: f.now, status: "running",
    persona: { wpm: 180 } as RunState["persona"], warmupSuppressMs: 0, tabId: 7, armedSend: false,
  };
}

beforeEach(async () => {
  vi.resetModules();
  f.now = Date.parse("2026-10-06T12:00:00Z"); f.mode = "empty";
  f.submits = 0; f.probes = 0; f.typed = 0; f.calls = []; f.order = [];
  f.sentFailure = false; f.activityFailure = false; f.claimed = false; f.comment = false; f.onMessage = null;
  f.state = makeState(); document.body.innerHTML = "";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(Date, "now").mockImplementation(() => f.now);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!requestUrl.startsWith(cfg.apiBaseUrl)) throw new Error("unexpected external request blocked");
    const path = new URL(requestUrl).pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    f.calls.push({ path, method: init?.method ?? "GET", body });
    if (path.endsWith("reddit-reply-claim")) {
      if (f.claimed) return Response.json({ error: "already_claimed" }, { status: 409 });
      f.claimed = true;
      return Response.json({ claimed: true });
    }
    if (path.endsWith("enable-send")) return Response.json({ prior: true });
    if (path.includes("mark-sent")) {
      f.order.push("mark-sent");
      return Response.json({}, { status: f.sentFailure ? 503 : 200 });
    }
    if (path.endsWith("actionable-reddit")) return Response.json({ replies: [{ approval_id: ids.approval, draft_id: ids.draft, lead_id: ids.lead, kind: "reply", body: item().body,
      target: f.comment
        ? { type: "comment", url: `${url}def456/`, post_id: "abc123", comment_id: "def456", subreddit: "saas", author: "ada" }
        : { type: "post", url, post_id: "abc123", subreddit: "saas", author: "ada" } }] });
    if (path.endsWith("reddit-activity")) return Response.json({}, { status: f.activityFailure ? 503 : 200 });
    if (path.includes("mark-skipped")) return Response.json({});
    throw new Error(`unhandled inert API call: ${path}`);
  }));
  const addListener = vi.fn();
  vi.stubGlobal("chrome", {
    storage: { local: { get: async () => ({ "actuator.config": cfg, "actuator.automationStartMs": f.now - 40 * 86400000 }), set: async () => {}, remove: async () => {} } },
    runtime: { onStartup: { addListener }, onInstalled: { addListener }, onMessage: { addListener: (cb: typeof f.onMessage) => { f.onMessage = cb; } } },
    alarms: { onAlarm: { addListener }, clear: async () => {}, create: async () => {} },
    tabs: {
      query: async () => [{ id: 7, url: "https://www.reddit.com/" }],
      get: async () => ({ status: "complete", url }), update: async () => {},
      sendMessage: async (_id: number, message: { cmd: string; commentId?: string }) => {
        switch (message.cmd) {
          case "detectChallenge": return { observed: { challenge: f.mode === "post-challenge" && f.submits > 0 } };
          case "checkPostRemoved": return { removed: f.mode === "removed", positive: f.mode === "removed" };
          case "checkCommentsLocked": return { blocked: false };
          case "locateComposerEntry": return locate(10);
          case "locateCommentReplyButton": return { ...locate(10), observed: { comment_id: "def456" } };
          case "locateReplyBox": return locate(20);
          case "locateReplySubmit": return f.mode === "submit-missing" ? { ok: false, skipReason: "reply-submit-disabled" } : locate(30);
          case "readReplyBox": return readReplyBox(document.body, "www.reddit.com");
          case "diagnoseReplySubmit": return { observed: {} };
          case "locateDirtyReplyBox": return { ok: false, observed: { present: false } };
          case "verifyReplyPosted":
            f.probes++;
            if (f.mode === "read-error") throw new Error("content script disconnected");
            if (f.mode === "late" && f.probes === 9) document.body.innerHTML = '<div contenteditable="true" name="body" role="textbox"></div>';
            return { ok: true, ...verifyReplyCleared(document.body, "www.reddit.com", message.commentId) };
          default: throw new Error(`unexpected DOM command: ${message.cmd}`);
        }
      },
    },
  });
  await import("../src/background/index.js");
  await activate();
  expect(f.onMessage).not.toBeNull();
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const message = (cmd: string, params?: object) => new Promise<unknown>(resolve =>
  f.onMessage!({ cmd, ...(params ? { params } : {}) }, {}, resolve));
async function activate(comment = false) {
  f.comment = comment;
  expect(await message("startRun", { windowHours: 8, targetComments: 2, targetLikes: 0 })).toEqual({ ok: true });
  const pool = f.state!.commentPool;
  const epoch = f.state!.epoch;
  f.state = { ...makeState(), epoch, commentPool: pool };
}
const tick = () => new Promise<unknown>((resolve) => f.onMessage!({ cmd: "tick" }, {}, resolve));

describe("current Reddit registered tick post-submit lifecycle", () => {
  it.each(["dirty", "read-error", "post-challenge"] as const)("does not automatically requeue a dispatched %s result", async mode => {
    f.mode = mode; await tick();
    expect(f.submits).toBe(1);
    expect(f.calls.filter(call => call.path.includes("mark-sent"))).toHaveLength(0);
    expect(f.state!.commentPool).toHaveLength(0);
    expect(f.state!.done.comments).toBe(0);
  });
  it("does not report a missing scoped composer as an observed successful post", async () => {
    f.mode = "absent"; await tick();
    expect(f.submits).toBe(1);
    expect(f.calls.filter(call => call.path.includes("mark-sent"))).toHaveLength(0);
    expect(f.state!.done.comments).toBe(0);
  });
  it("does not report an absent exact comment composer as observed confirmation", async () => {
    f.mode = "absent";
    await activate(true);
    await tick();
    expect(f.submits).toBe(1);
    expect(f.calls.filter(call => call.path.includes("mark-sent"))).toHaveLength(0);
    expect(f.state!.done.comments).toBe(0);
  });
  it("does not replay an ambiguous CDP send after ordinary replenishment", async () => {
    f.mode = "click-throw"; await tick();
    expect(f.submits).toBe(1);
    expect(f.calls.filter(call => call.path.includes("mark-sent"))).toHaveLength(0);
    f.now += 30 * 60_000;
    f.state!.actions[0]!.atMs = f.now - 1;
    await tick();
    expect(f.calls.some(call => call.path.endsWith("actionable-reddit"))).toBe(true);
    expect(f.submits).toBe(1);
  });
  it("retains the thread reservation across two newly initialized runs in one service worker", async () => {
    f.mode = "dirty"; await tick();
    expect(f.submits).toBe(1);
    await activate();
    await tick();
    expect(f.submits).toBe(1);
  });
  it("keeps a no-submit readiness miss safely retryable", async () => {
    f.mode = "submit-missing"; await tick();
    expect(f.submits).toBe(0);
    expect(f.state!.commentPool).toHaveLength(1);
    expect(f.state!.commentPool[0]!.tries).toBe(1);
    expect(f.calls.filter(call => call.path.includes("mark-sent"))).toHaveLength(0);

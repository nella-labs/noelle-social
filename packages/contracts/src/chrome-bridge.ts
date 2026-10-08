import { z } from "zod";

// Contracts for the Chrome Bridge — a localhost control plane that gives Claude
// agents hands on the operator's real Chrome and gives the actuators (Vega/X,
// Lyra/LinkedIn, Orion/Reddit) a place to mirror logs + heartbeats.
//
// Three parties speak these shapes:
//   1. apps/chrome-bridge      — the Node control server (Hono HTTP + ws hub) on
//                                127.0.0.1:18792. Owns the log/heartbeat sink.
//   2. apps/chrome-bridge-ext  — the MV3 extension living in the operator's
//                                Chrome. Connects to the hub over WS as "the
//                                hands" and executes ChromeOps.
//   3. callers                 — the chrome MCP server, the noelle CLI, and the
//                                actuator-doctor, which drive Chrome over the
//                                HTTP control API and read the sink.
//
// Design invariant: the DEFAULT control path (tabs/dom/screenshot/console) uses
// chrome.scripting + chrome.tabs and never touches the single per-tab
// chrome.debugger slot, so it can NEVER collide with a live actuator run. The
// debugger.* ops are opt-in and guarded (see ChromeDebuggerAttachSchema.force).

// ---------------------------------------------------------------------------
// ChromeOp — the unit of work the extension executes. Discriminated on `op`.
// ---------------------------------------------------------------------------

export const TabInfoSchema = z.object({
  id: z.number(),
  windowId: z.number(),
  index: z.number().optional(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  status: z.string().optional(), // 'loading' | 'complete'
  discarded: z.boolean().optional(),
  audible: z.boolean().optional(),
  // true when a chrome.debugger session is attached to this tab (ours or an
  // actuator's) — callers use this to avoid stealing the debugger slot.
  debuggerAttached: z.boolean().optional(),
});
export type TabInfo = z.infer<typeof TabInfoSchema>;

export const ExtensionInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  version: z.string().optional(),
  installType: z.string().optional(), // 'development' | 'normal' | ...
  mayDisable: z.boolean().optional(),
});
export type ExtensionInfo = z.infer<typeof ExtensionInfoSchema>;

// Each op is `{ op: "<name>", ...args }`. Results are ChromeOpResult.
export const ChromeOpSchema = z.discriminatedUnion("op", [
  // --- tabs (chrome.tabs; no debugger slot) ---
  z.object({ op: z.literal("tabs.list"), urlPattern: z.string().optional() }),
  z.object({
    op: z.literal("tabs.create"),
    url: z.string().url(),
    active: z.boolean().default(true),
    windowId: z.number().optional(),
  }),
  z.object({ op: z.literal("tabs.navigate"), tabId: z.number(), url: z.string().url() }),
  z.object({ op: z.literal("tabs.activate"), tabId: z.number() }),
  z.object({ op: z.literal("tabs.close"), tabId: z.number() }),
  z.object({ op: z.literal("tabs.reload"), tabId: z.number(), bypassCache: z.boolean().default(false) }),
  z.object({ op: z.literal("tabs.waitForLoad"), tabId: z.number(), timeoutMs: z.number().int().max(120_000).default(30_000) }),

  // --- DOM/JS (chrome.scripting.executeScript; no debugger slot) ---
  // eval runs in the page's MAIN world and must return a JSON-serializable value.
  z.object({
    op: z.literal("dom.eval"),
    tabId: z.number(),
    expression: z.string().min(1),
    world: z.enum(["MAIN", "ISOLATED"]).default("MAIN"),
    awaitPromise: z.boolean().default(true),
  }),
  z.object({ op: z.literal("dom.click"), tabId: z.number(), selector: z.string().min(1) }),
  z.object({
    op: z.literal("dom.type"),
    tabId: z.number(),
    selector: z.string().min(1),
    text: z.string(),
    // dispatch input/change events after setting the value (React-friendly).
    dispatchEvents: z.boolean().default(true),
  }),
  z.object({
    op: z.literal("dom.query"),
    tabId: z.number(),
    selector: z.string().min(1),
    // return outerHTML/text/attrs for up to `limit` matches.
    limit: z.number().int().min(1).max(50).default(10),
  }),

  // --- capture ---
  z.object({
    op: z.literal("page.screenshot"),
    tabId: z.number().optional(), // defaults to the active tab of the focused window
    format: z.enum(["png", "jpeg"]).default("png"),
    quality: z.number().int().min(1).max(100).optional(),
  }),
  // recent console lines captured by the bridge content script's ring buffer.
  z.object({
    op: z.literal("page.console"),
    tabId: z.number(),
    sinceMs: z.number().int().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),

  // --- extension management (chrome.management) ---
  z.object({ op: z.literal("ext.list") }),
  z.object({ op: z.literal("ext.reload"), extId: z.string().min(1) }),
  z.object({ op: z.literal("ext.setEnabled"), extId: z.string().min(1), enabled: z.boolean() }),

  // --- guarded chrome.debugger passthrough (consumes the per-tab slot) ---
  // force=true attaches even when the tab already has a debugger session or is
  // an actuator domain (x.com/linkedin.com/reddit.com). Default refuses to
  // avoid derailing a live actuator run.
  z.object({ op: z.literal("debugger.attach"), tabId: z.number(), force: z.boolean().default(false) }),
  z.object({
    op: z.literal("debugger.command"),
    tabId: z.number(),
    method: z.string().min(1), // e.g. "Runtime.evaluate", "Input.dispatchKeyEvent"
    params: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({ op: z.literal("debugger.detach"), tabId: z.number() }),

  // --- meta ---
  z.object({ op: z.literal("meta.ping") }),
  z.object({ op: z.literal("meta.info") }), // chrome version, ext version, attached debuggers
]);
export type ChromeOp = z.infer<typeof ChromeOpSchema>;

export const ChromeOpResultSchema = z.object({
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.string().optional(),
  // ms the op took inside the extension, for latency telemetry.
  tookMs: z.number().optional(),
});
export type ChromeOpResult = z.infer<typeof ChromeOpResultSchema>;

// ---------------------------------------------------------------------------
// Extension transport (bridge <-> extension) = HTTP short-poll.
//
// An MV3 service worker is evicted after ~30s idle, which would kill a
// persistent WebSocket — the same reason the actuators drive their SW from a
// content-script setInterval. So the bridge extension polls instead: a
// content-script setInterval (~1.5s) wakes the SW, which calls GET /ext/poll,
// executes any queued ChromeOps, and POSTs results back to /ext/result. This
// needs no server-side socket library and survives SW eviction. Op latency is a
// poll interval, which is fine for agent-driven debugging.
// ---------------------------------------------------------------------------

// One queued op the bridge hands to the extension, tagged with a correlation id.
export const OpRequestSchema = z.object({
  id: z.string(), // correlation id
  op: ChromeOpSchema,
});
export type OpRequest = z.infer<typeof OpRequestSchema>;

// GET /ext/poll?token= response: ops waiting for the extension, plus the sink
// config the bridge wants the ext to honor (e.g. console-capture toggles).
export const ExtPollResponseSchema = z.object({
  requests: z.array(OpRequestSchema),
});
export type ExtPollResponse = z.infer<typeof ExtPollResponseSchema>;

// POST /ext/result body: one completed op result.
export const OpResultReportSchema = z.object({
  id: z.string(),
  result: ChromeOpResultSchema,
});
export type OpResultReport = z.infer<typeof OpResultReportSchema>;

// POST /ext/hello body: the extension announces itself on (re)connect. The
// bridge uses this to populate BridgeHealth.ext_* fields.
export const ExtHelloSchema = z.object({
  extId: z.string(),
  extVersion: z.string(),
  chromeVersion: z.string().optional(),
  buildStamp: z.string().optional(),
});
export type ExtHello = z.infer<typeof ExtHelloSchema>;

// Unsolicited events the ext pushes up (console lines, tab events) via
// POST /ext/event. Heartbeats use the shared HeartbeatSchema on /ingest/heartbeat.
export const ExtEventSchema = z.object({
  kind: z.enum(["console", "debugger", "tab"]),
  at: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type ExtEvent = z.infer<typeof ExtEventSchema>;

// ---------------------------------------------------------------------------
// Log + heartbeat sink. Actuators (and the bridge-ext) POST these; the bridge
// appends them to ~/.noelle/logs/actuators/<source>.ndjson and keeps the latest
// heartbeat per source. The doctor + MCP + CLI read them back.
// ---------------------------------------------------------------------------

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

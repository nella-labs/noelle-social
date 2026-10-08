#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ChromeOpSchema } from "@noelle/contracts";
import { ZodError } from "zod";
import { BridgeClient } from "./client.js";

// Low-level stdio MCP server for the Chrome Bridge. Same architecture as the
// Noelle MCP (apps/noelle-mcp): a hand-written Tool[] advertised by ListTools
// and a CallTool switch. Each chrome_* tool builds a ChromeOp from its args,
// validates it against the shared ChromeOpSchema (applying defaults + catching
// bad input early with a clean error), and POSTs it to the bridge — except
// chrome_logs / chrome_heartbeats / chrome_doctor, which read the sink.
//
// stdout is the JSON-RPC channel; ALL logging goes to stderr.

const client = new BridgeClient();

// --- arg extractors (MCP args are untrusted; coerce narrowly, let the shared
// ChromeOpSchema reject anything that ends up missing/wrong) ---
type Args = Record<string, unknown>;
const str = (a: Args, k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined);
const num = (a: Args, k: string): number | undefined => (typeof a[k] === "number" ? (a[k] as number) : undefined);
const bool = (a: Args, k: string): boolean | undefined => (typeof a[k] === "boolean" ? (a[k] as boolean) : undefined);
const rec = (a: Args, k: string): Record<string, unknown> | undefined =>
  a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? (a[k] as Record<string, unknown>) : undefined;

// --- result envelopes: the MCP text shape every handler returns ---
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
}
function toolResult(result: unknown, isError: boolean): ToolResult {
  const out: ToolResult = { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  if (isError) out.isError = true;
  return out;
}
function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}
// A client call failed when it came back as `{ ok:false }` (network error, HTTP
// error, or an op the extension reported as failed — e.g. selector not found).
function isFailure(r: unknown): boolean {
  return !!r && typeof r === "object" && (r as { ok?: unknown }).ok === false;
}

const NO_ARGS = { type: "object" as const, properties: {} };

const TOOLS: Tool[] = [
  {
    name: "chrome_tabs",
    description:
      "List open Chrome tabs (id, url, title, active, and whether a chrome.debugger session is attached). Optional urlPattern filters (Chrome match pattern, e.g. '*://x.com/*'). Uses chrome.tabs and never takes the debugger slot, so it is safe during a live actuator run.",
    inputSchema: {
      type: "object",
      properties: {
        urlPattern: { type: "string", description: "Optional Chrome match pattern to filter tabs, e.g. '*://linkedin.com/*'." },
      },
    },
  },
  {
    name: "chrome_open",
    description: "Open a new Chrome tab at a URL. Set active:false to open it in the background. Returns the new tab's info.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open (http/https)." },
        active: { type: "boolean", description: "Focus the new tab. Defaults to true." },
      },
      required: ["url"],
    },
  },
  {
    name: "chrome_navigate",
    description: "Navigate an existing tab (by tabId) to a new URL.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id (from chrome_tabs)." },
        url: { type: "string", description: "URL to navigate to (http/https)." },
      },
      required: ["tabId", "url"],
    },
  },
  {
    name: "chrome_close",
    description: "Close a tab by tabId.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number", description: "Tab id to close." } },
      required: ["tabId"],
    },
  },
  {
    name: "chrome_eval",
    description:
      "Run a JavaScript expression IN THE PAGE and return its JSON-serializable result. Runs in the page's MAIN world by default (set world:'ISOLATED' for the content-script world). Promises are awaited. Uses chrome.scripting and never takes the debugger slot. Examples: 'document.title', 'document.querySelectorAll(\"article\").length'.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab id to run in." },
        expression: { type: "string", description: "JavaScript expression to evaluate in the page." },
        world: { type: "string", enum: ["MAIN", "ISOLATED"], description: "Execution world. Defaults to MAIN (the page's own JS context)." },
      },
      required: ["tabId", "expression"],
    },
  },
  {
    name: "chrome_click",
    description: "Click the first element matching a CSS selector in a tab (a real click dispatched via chrome.scripting).",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab id." },
        selector: { type: "string", description: "CSS selector of the element to click." },
      },
      required: ["tabId", "selector"],
    },
  },
  {
    name: "chrome_type",
    description:
      "Set the value of the first input/textarea matching a CSS selector to `text` and dispatch input/change events (React-friendly).",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab id." },
        selector: { type: "string", description: "CSS selector of the input/textarea." },
        text: { type: "string", description: "Text to set as the element's value." },
      },
      required: ["tabId", "selector", "text"],
    },
  },
  {
    name: "chrome_query",
    description: "Query the DOM: return outerHTML/text/attributes for up to `limit` elements matching a CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab id." },
        selector: { type: "string", description: "CSS selector to match." },
        limit: { type: "number", description: "Max matches to return (1-50). Defaults to 10." },
      },
      required: ["tabId", "selector"],
    },
  },
  {
    name: "chrome_screenshot",
    description:
      "Capture a screenshot of a tab (defaults to the active tab of the focused window). Returns a base64 PNG data URL in the result's `value` — that value is an image, not text.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab id. Omit to capture the active tab of the focused window." },
      },
    },
  },
  {
    name: "chrome_console",
    description: "Return recent console lines captured for a tab (from the bridge content script's ring buffer), up to `limit`.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Tab id." },
        limit: { type: "number", description: "Max lines to return (1-500). Defaults to 100." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "chrome_extensions",
    description:
      "List installed Chrome extensions (id, name, enabled, version, installType). Use this to find an actuator's extension id before reloading it.",
    inputSchema: NO_ARGS,
  },
  {
    name: "chrome_reload_extension",
    description:
      "Reload an unpacked extension by id (chrome.management). Use to pick up a new actuator build without a manual chrome://extensions reload.",
    inputSchema: {
      type: "object",
      properties: { extId: { type: "string", description: "Extension id (from chrome_extensions)." } },
      required: ["extId"],
    },
  },
  {
    name: "chrome_debugger",
    description:
      "Guarded chrome.debugger (CDP) passthrough. action:'attach' takes the single per-tab debugger slot, 'command' sends a CDP method (e.g. 'Runtime.evaluate') with params, 'detach' releases it. WARNING: there is exactly ONE debugger slot per tab and a live actuator owns it on its x.com / linkedin.com / reddit.com tab. Attaching to an actuator domain (or an already-attached tab) is REFUSED unless force:true, to avoid derailing a running actuator. Prefer chrome_eval / chrome_click / chrome_query, which never take the slot.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["attach", "command", "detach"], description: "attach = take the slot, command = send a CDP method, detach = release." },
        tabId: { type: "number", description: "Target tab id." },
        method: { type: "string", description: "CDP method for action:'command', e.g. 'Runtime.evaluate'." },
        params: { type: "object", description: "CDP params object for action:'command', e.g. { expression: '1+1' }." },
        force: { type: "boolean", description: "For action:'attach' only: attach even on an actuator domain or an already-attached tab. Use with care — it can derail a live actuator run." },
      },
      required: ["action", "tabId"],
    },
  },
  {
    name: "chrome_logs",
    description:
      "Query the actuator log sink (~/.noelle/logs/actuators). Filter by source (e.g. 'x-actuator', 'linkedin-actuator', 'reddit-intern', 'actuator-doctor', 'chrome-bridge-ext'), sinceMs (unix ms lower bound), level, grep (substring on the message), and limit.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Filter to one source slug." },
        sinceMs: { type: "number", description: "Only entries at/after this unix-ms timestamp." },
        level: { type: "string", enum: ["debug", "info", "warn", "error"], description: "Minimum/exact level filter (bridge-defined)." },
        grep: { type: "string", description: "Substring match on the log message." },
        limit: { type: "number", description: "Max entries to return." },
      },
    },
  },
  {
    name: "chrome_heartbeats",
    description:
      "Bridge + extension health (is Chrome connected? ext/chrome versions) plus the latest heartbeat per actuator source (state, age, stale flag). The one-glance 'is everything alive' check.",
    inputSchema: NO_ARGS,
  },
  {
    name: "chrome_doctor",
    description:
      "The actuator-doctor's latest health snapshot (read from ~/.noelle/doctor/last-report.json): current probes, matched failure signatures, and remediation state. Empty with a hint if the doctor has not run yet.",
    inputSchema: NO_ARGS,
  },
];

// Build the raw ChromeOp for an op-backed tool (validated by ChromeOpSchema
// before it leaves). Returns null when the tool is not op-backed / unknown.
function buildOp(name: string, a: Args): unknown {
  switch (name) {
    case "chrome_tabs":
      return { op: "tabs.list", urlPattern: str(a, "urlPattern") };
    case "chrome_open":
      return { op: "tabs.create", url: str(a, "url"), active: bool(a, "active") };
    case "chrome_navigate":
      return { op: "tabs.navigate", tabId: num(a, "tabId"), url: str(a, "url") };
    case "chrome_close":
      return { op: "tabs.close", tabId: num(a, "tabId") };
    case "chrome_eval":
      return { op: "dom.eval", tabId: num(a, "tabId"), expression: str(a, "expression"), world: str(a, "world") };
    case "chrome_click":
      return { op: "dom.click", tabId: num(a, "tabId"), selector: str(a, "selector") };
    case "chrome_type":
      return { op: "dom.type", tabId: num(a, "tabId"), selector: str(a, "selector"), text: str(a, "text") };
    case "chrome_query":
      return { op: "dom.query", tabId: num(a, "tabId"), selector: str(a, "selector"), limit: num(a, "limit") };
    case "chrome_screenshot":
      return { op: "page.screenshot", tabId: num(a, "tabId") };
    case "chrome_console":
      return { op: "page.console", tabId: num(a, "tabId"), limit: num(a, "limit") };
    case "chrome_extensions":
      return { op: "ext.list" };
    case "chrome_reload_extension":
      return { op: "ext.reload", extId: str(a, "extId") };
    case "chrome_debugger": {
      const action = str(a, "action");
      const tabId = num(a, "tabId");
      switch (action) {
        case "attach":
          return { op: "debugger.attach", tabId, force: bool(a, "force") };
        case "command":
          return { op: "debugger.command", tabId, method: str(a, "method"), params: rec(a, "params") };
        case "detach":
          return { op: "debugger.detach", tabId };
        default:
          throw new Error(`chrome_debugger: action must be 'attach', 'command', or 'detach' (got ${action ?? "undefined"}).`);
      }
    }
    default:
      return null;
  }
}

async function handle(name: string, a: Args): Promise<ToolResult> {
  switch (name) {
    case "chrome_logs": {
      const result = await client.logs({
        source: str(a, "source"),
        sinceMs: num(a, "sinceMs"),
        level: str(a, "level"),
        grep: str(a, "grep"),
        limit: num(a, "limit"),
      });
      return toolResult(result, isFailure(result));
    }
    case "chrome_heartbeats": {
      // Surface bridge/ext health alongside the actuator heartbeats — the agent
      // wants to know Chrome is even connected before trusting stale heartbeats.
      const [heartbeats, bridge] = await Promise.all([client.heartbeats(), client.health()]);
      return toolResult({ bridge, heartbeats }, isFailure(bridge) || isFailure(heartbeats));
    }
    case "chrome_doctor": {
      const result = await client.doctorReport();
      return toolResult(result, isFailure(result));
    }
    default: {
      const raw = buildOp(name, a);
      if (raw === null) return errorResult(`Unknown tool: ${name}`);
      const op = ChromeOpSchema.parse(raw); // fills defaults, rejects bad input
      const result = await client.op(op);
      return toolResult(result, isFailure(result));
    }
  }
}

async function main(): Promise<void> {
  const server = new Server(
    { name: "chrome-bridge", version: "0.0.1-alpha.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Args;
    try {
      return await handle(name, args);
    } catch (err) {
      if (err instanceof ZodError) {
        const detail = err.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return errorResult(`invalid arguments for ${name}: ${detail}`);
      }
      return errorResult(`executing ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel; all logging must go to stderr.
  console.error(`[chrome-bridge-mcp] ready — ${TOOLS.length} tools (bridge ${process.env.NOELLE_BRIDGE_URL || "http://127.0.0.1:18792"})`);

  const shutdown = (): void => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[chrome-bridge-mcp] fatal:", err);
  process.exit(1);
});

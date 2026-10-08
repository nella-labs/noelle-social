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

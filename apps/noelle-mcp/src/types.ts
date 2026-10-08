import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { NoelleContext } from "./context.js";

// The MCP text-result envelope every handler returns. Mirrors the shape the
// low-level SDK expects back from a CallTool handler.
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

// A category module (agents, leads, approvals, …). `tools` is what ListTools
// advertises; `handle` is tried on every CallTool and returns `null` when the
// name isn't one of this module's tools, so the server can fall through to the
// next module — the exact pattern the Nella MCP uses.
export interface ToolModule {
  tools: Tool[];
  handle(
    name: string,
    args: Record<string, unknown>,
    ctx: NoelleContext,
  ): Promise<ToolResult | null>;
}

export type { Tool };

#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { NoelleContext } from "./context.js";
import { closeDb } from "./db.js";
import { errorResult } from "./result.js";
import { MODULES } from "./tools/index.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { withToolAnnotations } from "./tool-annotations.js";

// Low-level stdio MCP server for Noelle. Same architecture as the Nella MCP:
// each category module contributes a `tools` array (advertised by ListTools)
// and a `handle` fn tried on every CallTool. A `null` from handle means "not my
// tool", so the server falls through to the next module.

async function main(): Promise<void> {
  const ctx = NoelleContext.create();

  const server = new Server(
    { name: "noelle", version: "0.0.1-alpha.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  const allTools: Tool[] = MODULES.flatMap((m) => m.tools).map(withToolAnnotations);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      for (const mod of MODULES) {
        const res = await mod.handle(name, args, ctx);
        if (res) return res;
      }
      return errorResult(`Unknown tool: ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`executing ${name}: ${msg}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel; all logging must go to stderr.
  console.error(`[noelle-mcp] ready — ${allTools.length} tools across ${MODULES.length} modules`);

  const shutdown = async (): Promise<void> => {
    await closeDb().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[noelle-mcp] fatal:", err);
  process.exit(1);
});

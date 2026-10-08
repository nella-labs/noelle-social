import { z } from "zod";
import type { AgentTool } from "./types.js";
import type { RuntimeServices } from "./services.js";

const SearchInput = z.object({ q: z.string(), workspace: z.string().min(1) });

/** Direct search requires an explicitly configured workspace. */
export function createContextSearchTool(svc: RuntimeServices): AgentTool {
  return {
    id: "nella.search",
    input: SearchInput,
    handler: async (input) => {
      const { q, workspace } = SearchInput.parse(input);
      return svc.nella.searchContext({ query: q, workspace });
    },
  };
}

/** Voice context comes only from this organization's configured vault. */
export async function getAgentAnchors(
  svc: RuntimeServices,
  args: { orgId: string; query: string },
) {
  return svc.vault ? svc.vault.getAnchors(args) : [];
}

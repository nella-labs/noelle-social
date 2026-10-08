import type { Tool } from "./types.js";

// Explicit names: an unfamiliar tool keeps the protocol's conservative defaults.
const LOCAL_READS = new Set([
  "noelle_list_orgs", "noelle_get_org", "noelle_status",
  "noelle_list_agents", "noelle_get_agent",
  "noelle_list_leads", "noelle_get_lead",
  "noelle_get_reply_request_status", "noelle_list_friendly_dms",
  "noelle_list_approvals", "noelle_get_approval",
  "noelle_list_persons", "noelle_get_person", "noelle_list_watchlist",
  "noelle_list_post_ideas", "noelle_list_post_drafts", "noelle_get_post", "noelle_get_ideation_request",
  "noelle_list_connections", "noelle_get_spend",
  "noelle_recent_worker_runs", "noelle_active_workers", "noelle_search",
  "noelle_list_tables", "noelle_describe_table", "noelle_sql_query",
  "noelle_list_video_generation_holds",
]);

/** Clients can poll Noelle's local results without treating each read as a write. */
export function withToolAnnotations(tool: Tool): Tool {
  if (!LOCAL_READS.has(tool.name)) return tool;
  return {
    ...tool,
    annotations: {
      ...tool.annotations,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

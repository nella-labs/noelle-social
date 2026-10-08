import type { ToolModule } from "../types.js";
import { orgsModule } from "./orgs.js";
import { agentsModule } from "./agents.js";
import { approvalsModule } from "./approvals.js";
import { leadsModule } from "./leads.js";
import { friendlyDmsModule } from "./friendly-dms.js";
import { personsModule } from "./persons.js";
import { watchlistsModule } from "./watchlists.js";
import { contentModule } from "./content.js";
import { connectionsModule } from "./connections.js";
import { opsModule } from "./ops.js";
import { operateModule } from "./operate.js";
import { adminModule } from "./admin.js";
import { videoClaimsModule } from "./video-claims.js";

// Order matters only for the CallTool fall-through (first module whose handle
// returns non-null wins); tool names are globally unique so ordering is cosmetic.
export const MODULES: ToolModule[] = [
  orgsModule,
  agentsModule,
  approvalsModule,
  leadsModule,
  friendlyDmsModule,
  personsModule,
  watchlistsModule,
  contentModule,
  connectionsModule,
  opsModule,
  operateModule,
  adminModule,
  videoClaimsModule,
];

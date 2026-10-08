import type { CallAgentModelArgs, CallAgentModelResult } from "@noelle/runtime/call";
import type { NellaClient } from "@noelle/runtime/nella";
import type { VaultResolver } from "@noelle/runtime/vault";

/**
 * Bundle of runtime services an agent class needs to do its work. Constructed
 * once at process boot (dashboard server, VM worker) and passed into each
 * `create<Role>Agent` factory.
 *
 * `vault` retrieves voice context scoped to an organization. Without one,
 * drafting runs with no voice anchors. Direct Nella searches require an
 * explicit workspace and never supply another operator's default context.
 */
export type RuntimeServices = {
  callAgentModel: (args: CallAgentModelArgs) => Promise<CallAgentModelResult>;
  nella: NellaClient;
  vault?: VaultResolver;
};

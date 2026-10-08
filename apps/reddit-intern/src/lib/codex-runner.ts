import {
  callAgentModel as defaultCall,
  type CallAgentModelDeps,
  type ModelRouting,
} from "@noelle/runtime";
import type { AgentRole } from "@noelle/runtime/types";

export interface DraftCallArgs {
  bucket: string;
  routing: ModelRouting;
  orgId: string;
  instanceId: string;
  /** Which worker process is making this call. */
  worker: string;
  /** Which agent role is making this call. */
  agentRole: AgentRole;
  system: string;
  prompt: string;
}

export interface CodexRunner {
  draft(args: DraftCallArgs): Promise<{ text: string; engine: string; model: string }>;
}

export function createCodexRunner(
  deps: CallAgentModelDeps & { callAgentModel?: typeof defaultCall },
): CodexRunner {
  const call = deps.callAgentModel ?? defaultCall;
  return {
    async draft(args) {
      const res = await call(
        {
          bucket: args.bucket,
          routing: args.routing,
          orgId: args.orgId,
          instanceId: args.instanceId,
          worker: args.worker,
          agentRole: args.agentRole,
          system: args.system,
          prompt: args.prompt,
        },
        deps,
      );
      return { text: res.text, engine: res.engineUsed.engine, model: res.engineUsed.model };
    },
  };
}

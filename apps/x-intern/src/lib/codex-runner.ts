import {
  callAgentModel as defaultCall,
  makeLlmBackendResolver,
  type CallAgentModelDeps,
  type LlmBackendQuery,
  type ModelRouting,
} from "@noelle/runtime";
import type { AgentRole } from "@noelle/runtime/types";
import type { Sql } from "postgres";

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
  /** Bypass process-wide model overrides and use routing as supplied. */
  directRouting?: boolean;
  /** Use only the local Codex subscription; never probe Claude or paid APIs. */
  codexSubscriptionOnly?: boolean;
  codexReasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

export interface CodexRunner {
  draft(args: DraftCallArgs): Promise<{ text: string; engine: string; model: string }>;
}

export function createCodexRunner(
  deps: CallAgentModelDeps & {
    callAgentModel?: typeof defaultCall;
    /**
     * postgres.js client. When provided (and no explicit getLlmBackend is set),
     * the runner wires the per-org "AWS Bedrock ↔ Claude" backend switch
     * (noelle.organizations.llm_backend) so callAgentModel rewrites a bedrock
     * primary to the local claude-cli subscription when the org selects 'claude'.
     * Omit it (tests) and behavior stays env-flag driven.
     */
    sql?: Sql;
  },
): CodexRunner {
  const call = deps.callAgentModel ?? defaultCall;
  // One resolver per runner: a short TTL cache keyed by orgId, shared across
  // every draft() call this worker makes. getLlmBackend (if explicitly passed)
  // wins; otherwise derive it from sql; otherwise leave it unset (env flag).
  // The cast bridges postgres.js's heavily-overloaded `Sql` to the resolver's
  // minimal tagged-template shape (LlmBackendQuery) — see makeLlmBackendResolver.
  const getLlmBackend =
    deps.getLlmBackend ??
    (deps.sql ? makeLlmBackendResolver(deps.sql as unknown as LlmBackendQuery) : undefined);
  const callDeps: CallAgentModelDeps = { ...deps };
  if (getLlmBackend) callDeps.getLlmBackend = getLlmBackend;
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
          ...(args.directRouting ? { directRouting: true } : {}),
          ...(args.codexSubscriptionOnly ? { codexSubscriptionOnly: true } : {}),
          ...(args.codexReasoningEffort
            ? { codexReasoningEffort: args.codexReasoningEffort }
            : {}),
        },
        callDeps,
      );
      return { text: res.text, engine: res.engineUsed.engine, model: res.engineUsed.model };
    },
  };
}

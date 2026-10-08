import type { ZodTypeAny } from "zod";

import type { AgentRole } from "@noelle/contracts";
export type { AgentRole } from "@noelle/contracts";
export { SOCIAL_AGENT_ROLES, isSocialAgentRole } from "@noelle/contracts";

/**
 * Capability vocabulary for skill-to-agent routing (see
 * docs/agent-model.md § "Capability routing"). ORTHOGONAL to `AgentRole`:
 * capabilities describe *what* an intent needs done; roles describe *who* can
 * do it. The router does dynamic *selection over this static set of roles* — it
 * never mints a role. Keep this array small and coverage-tested so the manifest
 * stays the single source of truth for "what each agent can handle".
 *
 * A tag is a dotted `domain.object.action` string. Add a tag here first, then a
 * manifest may opt into it via its optional `capability.handles`.
 */
export const CAPABILITY_TAGS = [
  "content.video.script",
  "content.post.draft",
  "engagement.reply.x",
  "engagement.reply.linkedin",
  "engagement.reply.reddit",
] as const;

/** A declared capability tag. Closed union derived from {@link CAPABILITY_TAGS}. */
export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

/**
 * Where a capability can be invoked from. `agent_chat` = a free-text ask routed
 * to an agent's chat (the "Ask Noelle" box); `content` = the Content workspace;
 * `bus` = a shared-memory-bus event router. A manifest lists the surfaces each
 * capability is reachable on.
 */
export const CAPABILITY_SURFACES = [
  "agent_chat",
  "content",
  "bus",
] as const;

/** A declared invocation surface. Closed union derived from {@link CAPABILITY_SURFACES}. */
export type CapabilitySurface = (typeof CAPABILITY_SURFACES)[number];

/**
 * Optional capability facet of a {@link AgentManifest}. Declaring it opts a role
 * into dynamic routing; omitting it leaves the role reachable only via the
 * static surfaces that already know its role. All fields but `handles`/`surfaces`
 * are advisory. `intent_examples` are few-shot material for the LLM tier only.
 */
export type AgentCapability = {
  /** Capability tags this role can service. */
  handles: CapabilityTag[];
  /** Surfaces this role is invokable from for those capabilities. */
  surfaces: CapabilitySurface[];
  /** Tie-break when >1 role handles a tag on a surface. Higher wins. Default 0. */
  priority?: number;
  /** Few-shot examples for the (Phase 2) LLM disambiguation tier only. */
  intent_examples?: string[];
};

export type EngineHandle =
  | {
      engine: "vertex";
      model:
        | "claude-sonnet-4-6"
        | "gemini-2-flash"
        | "gemini-2-5-flash"
        | "gemini-2-5-pro";
    }
  | {
      engine: "bedrock";
      model:
        | "claude-haiku-4-5"
        | "claude-sonnet-4-6"
        | "claude-opus-4-6";
    }
  | {
      engine: "claude";
      model:
        | "claude-haiku-4-5"
        | "claude-sonnet-4-6"
        | "claude-opus-4-6";
    }
  | {
      // Local Claude Code CLI (`claude -p`) on a VM, billed against an
      // operator's Claude Max/Pro subscription instead of per-token Bedrock.
      // Never persisted in model_overrides — callAgentModel rewrites a
      // `bedrock` primary to this engine at dispatch when NOELLE_CLAUDE_CLI=1.
      engine: "claude-cli";
      model:
        | "claude-haiku-4-5"
        | "claude-sonnet-4-6"
        | "claude-opus-4-6";
    }
  | {
      // Local Codex CLI (`codex exec`) on a VM, billed against an operator's
      // ChatGPT subscription. The OpenAI-side twin of claude-cli: same trick,
      // a different pot. callAgentModel falls through to it when the Claude
      // budget is spent, so a weekly cap stops work instead of the month.
      engine: "codex-cli";
      model: "gpt-5-codex" | "gpt-5";
    }
  | {
      engine: "openai";
      model: "gpt-5" | "gpt-5-mini";
    };

/**
 * Worker IDs Noelle exposes for per-worker model routing. Discovery and
 * send don't call LLMs today, but the registry includes them so the
 * dashboard can render a complete worker grid.
 */
export type WorkerId = "discovery" | "classifier" | "drafter" | "send";

/** Per-worker override slot stored inside `agent_instances.model_overrides`. */
export type WorkerRouting = {
  primary: EngineHandle;
  fallback?: EngineHandle | null;
};

export type EscalationPredicate = (ctx: AgentCallContext) => boolean;

export type ModelRouting = {
  primary: EngineHandle;
  fallback?: EngineHandle;
  escalation?: {
    engine: EngineHandle;
    when: EscalationPredicate;
  };
};

export type AgentTool = {
  id: string;
  input: ZodTypeAny;
  handler: (input: unknown, ctx: AgentCallContext) => Promise<unknown>;
};

export type AgentInstanceRow = {
  id: string;
  org_id: string;
  role: AgentRole;
  status: "active" | "provisioning_alpha" | "paused";
  model_overrides: Partial<ModelRouting> | null;
  budget_cap_cents: number | null;
  /**
   * Operator-set mission (0017_agent_objective.sql). NULL = fall back to the
   * agent type's manifest `short_description` — collapse via
   * `resolveObjective()`. Never read this raw for display or prompts; always
   * resolve so a never-edited instance still shows a meaningful objective.
   */
  objective: string | null;
  hired_by: string | null;
  hired_at: string;
};

export type AgentCallContext = {
  orgId: string;
  instanceId: string;
  bucket: string;
  routing: ModelRouting;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  payload: unknown;
};

/**
 * Rendered detail-panel output. Typed as `unknown` so this package does not
 * depend on React; consumers (apps/app) cast to React.ReactNode.
 */
export type RenderedPanel = unknown;

export interface AgentType {
  readonly id: AgentRole;
  readonly defaultModel: ModelRouting;
  readonly defaultBucket: string;
  readonly tools: ReadonlyArray<AgentTool>;
  readonly render: (instance: AgentInstanceRow) => Promise<RenderedPanel>;
  readonly run?: (ctx: AgentCallContext) => Promise<void>;
}

export type ManifestEscalationPredicate =
  | { kind: "velocity_score_gte"; threshold: number }
  | { kind: "never" };

export type AgentManifest = {
  id: AgentRole;
  display_name: string;
  short_description: string;
  icon: string;
  default_model: {
    primary: EngineHandle;
    fallback?: EngineHandle;
    escalation?: {
      engine: EngineHandle["engine"];
      model: EngineHandle["model"];
      when: ManifestEscalationPredicate;
    };
  };
  default_bucket: string;
  default_budget_cap_cents: number;
  tools: string[];
